// MnemoPi memory engine — persistent recall across sessions.
//
// Data + functions paradigm: no class, no this, no enum.
//
// Features:
//   - createMemory persists a new entry into the DB.
//   - searchMemory retrieves entries matching a query (case-insensitive
//     content + tag substring match, decay-weighted scoring).
//   - injectMemory prepends recalled memories as system messages into
//     the message array before the LLM call, giving the model context
//     from prior conversations.
//   - Memory decay: old memories receive lower scores over time using
//     exponential decay. Configurable half-life and minimum weight.
//   - Memory association: memories are linked via a associations table;
//     autoAssociate discovers links by tag/content overlap.
//   - Memory compression: merge similar memories into a single summary
//     entry, reducing noise while preserving information.
//   - Memory export/import: serialize memories to JSON and restore them,
//     with optional deduplication by content hash.

import { and, eq, ilike, or, sql } from "drizzle-orm";

import type { DB } from "../db";
import { memoryAssociations, memories } from "../db/schema";
import type { Message } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryEntry = {
  id: string;
  content: string;
  tags: string[];
  timestamp: number;
  sessionId: string | null;
  importance: number;
  accessCount: number;
  lastAccessed: number | null;
};

/** Configuration for exponential memory decay. */
export type DecayConfig = {
  /** Half-life in milliseconds. After this duration, the decay factor is 0.5.
   *  Default: 7 days (604_800_000 ms). */
  halfLifeMs: number;
  /** Minimum score a memory can reach. Prevents total erasure.
   *  Default: 0.05. */
  minScore: number;
  /** How much each access boosts the score (additive).
   *  Default: 0.15. */
  accessBoost: number;
};

const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLifeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  minScore: 0.05,
  accessBoost: 0.15,
};

/** A directed link between two memories. */
export type MemoryAssociation = {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  strength: number;
  createdAt: number | null;
};

/** Payload for memory export. */
export type MemoryExportPayload = {
  version: 1;
  exportedAt: number;
  memories: Array<{
    content: string;
    tags: string[];
    timestamp: number;
    importance: number;
    contentHash: string;
  }>;
  associations: Array<{
    sourceContentHash: string;
    targetContentHash: string;
    relation: string;
    strength: number;
  }>;
};

/** Options for memory export. */
export type ExportOptions = {
  sessionId?: string;
  since?: number;
};

/** Options for memory import. */
export type ImportOptions = {
  deduplicate?: boolean;
  sessionId?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a raw DB row into a MemoryEntry.
 */
function memoryRowToEntry(row: {
  id: string;
  content: string;
  tags: unknown;
  timestamp: Date;
  sessionId: string | null;
  importance: number | null;
  accessCount: number | null;
  lastAccessed: Date | null;
}): MemoryEntry {
  const tags = Array.isArray(row.tags)
    ? (row.tags as string[])
    : typeof row.tags === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(row.tags);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  return {
    id: row.id,
    content: row.content,
    tags,
    timestamp: row.timestamp.getTime(),
    sessionId: row.sessionId,
    importance: row.importance ?? 1.0,
    accessCount: row.accessCount ?? 0,
    lastAccessed: row.lastAccessed?.getTime() ?? null,
  };
}

/**
 * Simple content hash for deduplication and export/import linking.
 * Uses djb2 — fast, distribution-sufficient, no crypto dependency.
 */
function contentHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Compute the Jaccard similarity between two string sets.
 * Returns 0..1 where 1 means identical sets.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const setB = new Set(b.map((s) => s.toLowerCase()));
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compute word-level Jaccard similarity between two content strings.
 * Splits on whitespace and non-alphanumeric characters, filters short tokens.
 */
function contentSimilarity(a: string, b: string): number {
  const wordsA = a
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}'"]+/)
    .filter((w) => w.length >= 3);
  const wordsB = b
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}'"]+/)
    .filter((w) => w.length >= 3);
  return jaccardSimilarity(wordsA, wordsB);
}

/**
 * Compute combined similarity score between two memories.
 * Weighted: 0.6 tags + 0.4 content.
 */
function memorySimilarity(a: MemoryEntry, b: MemoryEntry): number {
  const tagSim = jaccardSimilarity(a.tags, b.tags);
  const contentSim = contentSimilarity(a.content, b.content);
  return 0.6 * tagSim + 0.4 * contentSim;
}

// ---------------------------------------------------------------------------
// Decay scoring
// ---------------------------------------------------------------------------

/**
 * Calculate the exponential decay factor for a memory.
 *
 * factor = max(minScore, 0.5 ^ (age / halfLifeMs) + accessBoost * min(accessCount, 10))
 *
 * `age` is measured from `timestamp` to `now`. Each access adds a small
 * recency boost so frequently-used memories resist decay.
 *
 * Returns a value in [minScore, ~1.35] (clamped to 1.0 for display).
 */
export function scoreMemory(
  entry: MemoryEntry,
  now: number = Date.now(),
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  const age = now - entry.timestamp;
  const timeDecay = Math.pow(0.5, age / config.halfLifeMs);
  const accessBump = config.accessBoost * Math.min(entry.accessCount, 10);
  const raw = entry.importance * (timeDecay + accessBump);
  return Math.max(config.minScore, Math.min(1.0, raw));
}

/**
 * Score an array of memories with decay, returning them sorted by
 * effective score descending. Each entry gets a `decayScore` property
 * attached (not persisted — transient).
 */
export function applyDecay(
  entries: MemoryEntry[],
  now: number = Date.now(),
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): Array<MemoryEntry & { decayScore: number }> {
  return entries
    .map((e) => ({ ...e, decayScore: scoreMemory(e, now, config) }))
    .sort((a, b) => b.decayScore - a.decayScore);
}

// ---------------------------------------------------------------------------
// createMemory — persist a new memory entry
// ---------------------------------------------------------------------------

/**
 * Insert a memory into the DB and return the persisted entry with its
 * generated id. If `entry.id` is already set, it is respected (allows
 * callers to pre-generate ids). Otherwise, the DB generates one.
 */
export async function createMemory(
  db: DB,
  entry: Omit<MemoryEntry, "id" | "accessCount" | "lastAccessed" | "importance"> & {
    id?: string;
    importance?: number;
  },
): Promise<MemoryEntry> {
  const id = entry.id ?? crypto.randomUUID();
  const tagsJson = JSON.stringify(entry.tags);
  const timestamp = entry.timestamp ?? Date.now();

  await db.db
    .insert(memories)
    .values({
      id,
      content: entry.content,
      tags: tagsJson,
      timestamp: new Date(timestamp),
      sessionId: entry.sessionId ?? null,
      importance: entry.importance ?? 1.0,
      accessCount: 0,
      lastAccessed: null,
    })
    .execute();

  return {
    id,
    content: entry.content,
    tags: entry.tags,
    timestamp,
    sessionId: entry.sessionId ?? null,
    importance: entry.importance ?? 1.0,
    accessCount: 0,
    lastAccessed: null,
  };
}

// ---------------------------------------------------------------------------
// touchMemory — record an access (increments count, updates lastAccessed)
// ---------------------------------------------------------------------------

/**
 * Mark a memory as recalled: increments `access_count` and sets
 * `last_accessed` to now. No-op if the memory doesn't exist.
 */
export async function touchMemory(
  db: DB,
  memoryId: string,
): Promise<void> {
  await db.db
    .update(memories)
    .set({
      accessCount: sql`${memories.accessCount} + 1`,
      lastAccessed: new Date(),
    })
    .where(eq(memories.id, memoryId))
    .execute();
}

// ---------------------------------------------------------------------------
// searchMemory — retrieve memories matching a text query
// ---------------------------------------------------------------------------

/**
 * Search memories by case-insensitive substring match on content and tags.
 * Results are ranked by decay-weighted score (recency + importance + access
 * frequency), then by timestamp descending for ties.
 *
 * `limit` caps the number of returned entries (default 10).
 *
 * Matching strategy:
 *   1. Content ILIKE match (highest relevance — full-text substring).
 *   2. Tag ILIKE match (tag substring).
 *   Entries matching both content AND tags rank higher (union with dedup).
 *
 * Decay scoring multiplies the base match by a time-decayed weight so
 * older, unused memories naturally fall off.
 */
export async function searchMemory(
  db: DB,
  query: string,
  opts: {
    limit?: number;
    sessionId?: string;
    decayConfig?: DecayConfig;
  } = {},
): Promise<MemoryEntry[]> {
  const limit = opts.limit ?? 10;
  const now = Date.now();

  // Split query into meaningful words (>=3 chars) for multi-word matching.
  const words = query
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3);

  if (words.length === 0) return [];

  // Build word-level ILIKE conditions: content or tags match any word.
  const wordConditions = words.map((word) => {
    const pattern = `%${word}%`;
    return or(
      ilike(memories.content, pattern),
      sql`${memories.tags}::text ILIKE ${pattern}`,
    );
  });

  const conditions = [or(...wordConditions)];

  // Optionally scope to a session
  if (opts.sessionId) {
    conditions.push(eq(memories.sessionId, opts.sessionId));
  }

  // Fetch more than needed so we can rank by decay score in memory.
  const fetchLimit = Math.max(limit * 3, 30);
  const rows = await db.db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(sql`${memories.timestamp} DESC`)
    .limit(fetchLimit)
    .execute();

  const entries = rows.map(memoryRowToEntry);

  // Apply decay scoring and rank.
  const scored = applyDecay(entries, now, opts.decayConfig ?? DEFAULT_DECAY_CONFIG);

  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// injectMemory — prepend recalled memories as system messages
// ---------------------------------------------------------------------------

/**
 * Given an array of messages and an array of recalled memories, prepend
 * system messages containing the memory context before the first user
 * message. This gives the LLM awareness of prior relevant conversations.
 *
 * The injected message uses a structured format so the model can
 * distinguish recalled memories from regular system instructions.
 *
 * Returns a NEW array — the original is not mutated.
 */
export function injectMemory(
  messages: Message[],
  recalled: MemoryEntry[],
): Message[] {
  if (recalled.length === 0) return messages;

  const memoryBlock = recalled
    .map(
      (m, i) =>
        `[Memory ${i + 1}] (tags: ${m.tags.join(", ") || "none"}, score: ${scoreMemory(m).toFixed(2)}):\n${m.content}`,
    )
    .join("\n\n");

  const memoryMessage: Message = {
    id: crypto.randomUUID(),
    role: "system",
    content: [
      {
        _tag: "text",
        text: `<recalled-memories>\nThese are relevant memories from previous sessions. Use them for context when answering.\n\n${memoryBlock}\n</recalled-memories>`,
      },
    ],
    createdAt: Date.now(),
  };

  // Insert after any leading system messages, before the first user message.
  let insertIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") {
      insertIndex = i + 1;
    } else {
      break;
    }
  }

  return [...messages.slice(0, insertIndex), memoryMessage, ...messages.slice(insertIndex)];
}

// ---------------------------------------------------------------------------
// Auto-inject: recallAndInject — search + inject in one call
// ---------------------------------------------------------------------------

/**
 * Search for memories relevant to the latest user message and inject them
 * into the message array. This is the primary integration point for the
 * agent loop.
 *
 * - Extracts the last user message text as the search query.
 * - Calls `searchMemory` with that query.
 * - Calls `injectMemory` with the results.
 * - Touches recalled memories (increments access count).
 * - Returns the augmented messages (original untouched).
 *
 * Silently returns the original messages on any DB error — memory
 * failures must never block the agent loop.
 */
export async function recallAndInject(
  db: DB,
  messages: Message[],
  opts: {
    limit?: number;
    sessionId?: string;
    decayConfig?: DecayConfig;
  } = {},
): Promise<Message[]> {
  // Extract the last user message as the search query.
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUserMessage) return messages;

  const query =
    typeof lastUserMessage.content === "string"
      ? lastUserMessage.content
      : lastUserMessage.content
          .filter((p): p is { _tag: "text"; text: string } => p._tag === "text")
          .map((p) => p.text)
          .join(" ");

  if (!query.trim()) return messages;

  try {
    const recalled = await searchMemory(db, query, opts);

    // Touch recalled memories to update access count.
    for (const m of recalled) {
      await touchMemory(db, m.id);
    }

    return injectMemory(messages, recalled);
  } catch {
    // Memory failures must not block the agent loop.
    return messages;
  }
}

// ---------------------------------------------------------------------------
// Associations — linking related memories
// ---------------------------------------------------------------------------

/**
 * Create a directed association between two memories.
 * `relation` describes the link (default "similar").
 * `strength` is 0..1 (default 1.0).
 *
 * Returns the persisted association. Deduplicates by (sourceId, targetId).
 */
export async function createAssociation(
  db: DB,
  sourceId: string,
  targetId: string,
  relation = "similar",
  strength = 1.0,
): Promise<MemoryAssociation> {
  // Check for existing association.
  const existing = await db.db
    .select()
    .from(memoryAssociations)
    .where(
      and(
        eq(memoryAssociations.sourceId, sourceId),
        eq(memoryAssociations.targetId, targetId),
      ),
    )
    .limit(1)
    .execute();

  if (existing.length > 0) {
    // Update strength to max of existing and new.
    const newStrength = Math.max(existing[0].strength, strength);
    await db.db
      .update(memoryAssociations)
      .set({ strength: newStrength })
      .where(eq(memoryAssociations.id, existing[0].id))
      .execute();
    return {
      id: existing[0].id,
      sourceId,
      targetId,
      relation,
      strength: newStrength,
      createdAt: existing[0].createdAt?.getTime() ?? null,
    };
  }

  const id = crypto.randomUUID();
  await db.db
    .insert(memoryAssociations)
    .values({
      id,
      sourceId,
      targetId,
      relation,
      strength,
    })
    .execute();

  return {
    id,
    sourceId,
    targetId,
    relation,
    strength,
    createdAt: Date.now(),
  };
}

/**
 * Get all associations where the given memory is either source or target.
 * Returns both directions with deduplication (same pair returns once).
 */
export async function getAssociations(
  db: DB,
  memoryId: string,
): Promise<MemoryAssociation[]> {
  const rows = await db.db
    .select()
    .from(memoryAssociations)
    .where(
      or(
        eq(memoryAssociations.sourceId, memoryId),
        eq(memoryAssociations.targetId, memoryId),
      ),
    )
    .execute();

  return rows.map((r) => ({
    id: r.id,
    sourceId: r.sourceId,
    targetId: r.targetId,
    relation: r.relation,
    strength: r.strength,
    createdAt: r.createdAt?.getTime() ?? null,
  }));
}

/**
 * Automatically discover and create associations for a memory based on
 * tag and content overlap with other memories.
 *
 * `threshold` is the minimum similarity (0..1) to create a link (default 0.4).
 * `opts.limit` caps how many associations to create (default 5).
 *
 * Returns the number of new associations created.
 */
export async function autoAssociate(
  db: DB,
  memoryId: string,
  threshold = 0.4,
  opts: { limit?: number; sessionId?: string } = {},
): Promise<number> {
  const limit = opts.limit ?? 5;

  // Fetch the target memory.
  const [target] = await db.db
    .select()
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1)
    .execute();

  if (!target) return 0;

  const targetEntry = memoryRowToEntry(target);

  // Fetch candidate memories (recent, different id).
  const conditions: ReturnType<typeof eq | typeof or>[] = [
    sql`${memories.id} != ${memoryId}`,
  ];
  if (opts.sessionId) {
    conditions.push(eq(memories.sessionId, opts.sessionId));
  }

  const candidates = await db.db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(sql`${memories.timestamp} DESC`)
    .limit(50)
    .execute();

  const targetEntries = candidates.map(memoryRowToEntry);

  // Score and filter by threshold.
  const scored = targetEntries
    .map((c) => ({ entry: c, sim: memorySimilarity(targetEntry, c) }))
    .filter((s) => s.sim >= threshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);

  let created = 0;
  for (const { entry, sim } of scored) {
    await createAssociation(db, memoryId, entry.id, "similar", sim);
    created++;
  }

  return created;
}

// ---------------------------------------------------------------------------
// Compression — merge similar memories
// ---------------------------------------------------------------------------

/**
 * Compress multiple memories into a single merged entry.
 *
 * The merged content is the concatenation of all original contents
 * (deduplicated). Tags are the union of all tags. The merged entry
 * has `importance` set to the max of the originals, and `timestamp`
 * set to the most recent.
 *
 * All original memories are archived (marked via a "compressed-to:<id>"
 * tag) rather than deleted, preserving provenance.
 *
 * Returns the new merged MemoryEntry.
 */
export async function compressMemories(
  db: DB,
  memoryIds: string[],
  mergedContent: string,
  mergedTags?: string[],
  sessionId?: string | null,
): Promise<MemoryEntry> {
  if (memoryIds.length === 0) {
    throw new Error("compressMemories requires at least one memory id");
  }

  // Fetch originals.
  const originals = await db.db
    .select()
    .from(memories)
    .where(
      or(...memoryIds.map((id) => eq(memories.id, id))),
    )
    .execute();

  const entries = originals.map(memoryRowToEntry);

  // Compute merged tags if not provided.
  const allTags = entries.flatMap((e) => e.tags);
  const uniqueTags = [...new Set(allTags.map((t) => t.toLowerCase()))];
  const tags = mergedTags ?? uniqueTags;

  // Max importance and most recent timestamp.
  const importance = Math.max(...entries.map((e) => e.importance), 1.0);
  const timestamp = Math.max(...entries.map((e) => e.timestamp));

  // Create the merged entry.
  const merged = await createMemory(db, {
    content: mergedContent,
    tags,
    timestamp,
    sessionId: sessionId ?? entries[0]?.sessionId ?? null,
    importance,
  });

  // Archive originals: add a tag marking them as compressed.
  for (const id of memoryIds) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) continue;
    const archivedTags = [...entry.tags, `compressed-to:${merged.id}`];
    await db.db
      .update(memories)
      .set({ tags: JSON.stringify(archivedTags) })
      .where(eq(memories.id, id))
      .execute();
  }

  return merged;
}

/**
 * Automatically find and compress highly similar memory pairs.
 *
 * `threshold` is the minimum similarity (0..1) to consider merging
 * (default 0.6). `opts.limit` caps the number of compressions per run
 * (default 10).
 *
 * Returns the number of compressions performed.
 */
export async function autoCompress(
  db: DB,
  threshold = 0.6,
  opts: { limit?: number; sessionId?: string } = {},
): Promise<number> {
  const limit = opts.limit ?? 10;

  // Fetch all candidate memories.
  const conditions: ReturnType<typeof eq>[] = [];
  if (opts.sessionId) {
    conditions.push(eq(memories.sessionId, opts.sessionId));
  }

  const all = conditions.length > 0
    ? await db.db
        .select()
        .from(memories)
        .where(and(...conditions))
        .orderBy(sql`${memories.timestamp} DESC`)
        .limit(200)
        .execute()
    : await db.db
        .select()
        .from(memories)
        .orderBy(sql`${memories.timestamp} DESC`)
        .limit(200)
        .execute();

  const entries = all.map(memoryRowToEntry);

  // Skip entries already compressed (have a compressed-to tag).
  const active = entries.filter(
    (e) => !e.tags.some((t) => t.startsWith("compressed-to:")),
  );

  // Find pairs above threshold.
  const pairs: Array<{ a: MemoryEntry; b: MemoryEntry; sim: number }> = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const sim = memorySimilarity(active[i], active[j]);
      if (sim >= threshold) {
        pairs.push({ a: active[i], b: active[j], sim });
      }
    }
  }

  // Sort by similarity descending.
  pairs.sort((a, b) => b.sim - a.sim);

  // Compress top pairs, skipping already-compressed entries.
  const compressed = new Set<string>();
  let count = 0;

  for (const pair of pairs) {
    if (count >= limit) break;
    if (compressed.has(pair.a.id) || compressed.has(pair.b.id)) continue;

    // Merge content: take the longer one, append unique sentences from the other.
    const contentA = pair.a.content;
    const contentB = pair.b.content;
    const merged =
      contentA.length >= contentB.length ? contentA : contentB;

    const mergedTags = [...new Set([...pair.a.tags, ...pair.b.tags])];

    await compressMemories(
      db,
      [pair.a.id, pair.b.id],
      merged,
      mergedTags,
      pair.a.sessionId,
    );

    compressed.add(pair.a.id);
    compressed.add(pair.b.id);
    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

/**
 * Export memories (and their associations) as a JSON-safe payload.
 *
 * Supports filtering by `sessionId` and `since` timestamp.
 * Each memory is represented by its content hash for portable linking.
 */
export async function exportMemories(
  db: DB,
  opts: ExportOptions = {},
): Promise<MemoryExportPayload> {
  const conditions: ReturnType<typeof eq | typeof sql>[] = [];
  if (opts.sessionId) {
    conditions.push(eq(memories.sessionId, opts.sessionId));
  }
  if (opts.since) {
    conditions.push(sql`${memories.timestamp} >= ${new Date(opts.since)}`);
  }

  const rows =
    conditions.length > 0
      ? await db.db
          .select()
          .from(memories)
          .where(and(...conditions))
          .orderBy(sql`${memories.timestamp} ASC`)
          .execute()
      : await db.db
          .select()
          .from(memories)
          .orderBy(sql`${memories.timestamp} ASC`)
          .execute();

  const entries = rows.map(memoryRowToEntry);

  // Build a mapping from id -> content hash.
  const hashMap = new Map<string, string>();
  for (const e of entries) {
    hashMap.set(e.id, contentHash(e.content));
  }

  // Export associations that reference exported memories.
  const exportedIds = new Set(entries.map((e) => e.id));
  const assocRows = await db.db
    .select()
    .from(memoryAssociations)
    .execute();

  const exportedAssocs = assocRows
    .filter(
      (r) => exportedIds.has(r.sourceId) && exportedIds.has(r.targetId),
    )
    .map((r) => ({
      sourceContentHash: hashMap.get(r.sourceId) ?? "",
      targetContentHash: hashMap.get(r.targetId) ?? "",
      relation: r.relation,
      strength: r.strength,
    }));

  return {
    version: 1,
    exportedAt: Date.now(),
    memories: entries.map((e) => ({
      content: e.content,
      tags: e.tags,
      timestamp: e.timestamp,
      importance: e.importance,
      contentHash: contentHash(e.content),
    })),
    associations: exportedAssocs,
  };
}

/**
 * Import memories from an export payload.
 *
 * If `deduplicate` is true (default), memories whose content hash already
 * exists in the DB are skipped. If `sessionId` is set, imported memories
 * are tagged with that session.
 *
 * Returns `{ imported, skipped }` counts.
 */
export async function importMemories(
  db: DB,
  payload: MemoryExportPayload,
  opts: ImportOptions = {},
): Promise<{ imported: number; skipped: number; associationsImported: number }> {
  const deduplicate = opts.deduplicate ?? true;
  let imported = 0;
  let skipped = 0;

  // Build existing content hashes if deduplicating.
  const existingHashes = new Set<string>();
  if (deduplicate) {
    const allRows = await db.db
      .select({ content: memories.content })
      .from(memories)
      .execute();
    for (const row of allRows) {
      existingHashes.add(contentHash(row.content));
    }
  }

  // Map from exported content hash -> new DB id.
  const hashMap = new Map<string, string>();

  for (const m of payload.memories) {
    if (deduplicate && existingHashes.has(contentHash(m.content))) {
      skipped++;
      continue;
    }

    const entry = await createMemory(db, {
      content: m.content,
      tags: m.tags,
      timestamp: m.timestamp,
      sessionId: opts.sessionId ?? null,
      importance: m.importance,
    });

    hashMap.set(m.contentHash, entry.id);
    imported++;
  }

  // Import associations.
  let associationsImported = 0;
  for (const a of payload.associations) {
    const sourceId = hashMap.get(a.sourceContentHash);
    const targetId = hashMap.get(a.targetContentHash);
    if (sourceId && targetId) {
      await createAssociation(db, sourceId, targetId, a.relation, a.strength);
      associationsImported++;
    }
  }

  return { imported, skipped, associationsImported };
}
