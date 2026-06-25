// Tests for MnemoPi memory engine (src/core/memory.ts)
//
// Covers:
//   - createMemory: persisting a memory entry
//   - searchMemory: case-insensitive content + tag search with decay scoring
//   - injectMemory: prepending recalled memories as system messages
//   - recallAndInject: combined search + inject with access tracking
//   - decay: scoreMemory and applyDecay
//   - associations: createAssociation, getAssociations, autoAssociate
//   - compression: compressMemories, autoCompress
//   - export/import: exportMemories, importMemories

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DB } from "../db";
import * as schema from "../db/schema";
import type { Message } from "./types";
import {
  applyDecay,
  autoAssociate,
  autoCompress,
  compressMemories,
  createAssociation,
  createMemory,
  exportMemories,
  getAssociations,
  importMemories,
  injectMemory,
  recallAndInject,
  scoreMemory,
  searchMemory,
  touchMemory,
} from "./memory";

// ---------------------------------------------------------------------------
// Test DB setup — ephemeral PGlite instance
// ---------------------------------------------------------------------------

let db: DB;
let pglite: PGlite;

beforeAll(async () => {
  pglite = new PGlite();

  // Create tables matching the production schema (including new columns).
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL DEFAULT 'New Session',
      parent_id UUID,
      branch_point INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content JSONB NOT NULL DEFAULT '[]',
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS configs (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content TEXT NOT NULL,
      tags JSONB NOT NULL DEFAULT '[]',
      timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
      session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
      importance REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS memory_associations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'similar',
      strength REAL NOT NULL DEFAULT 1.0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  db = { driver: "pglite", db: drizzle(pglite, { schema }) };
});

afterAll(async () => {
  await pglite.close();
});

// ---------------------------------------------------------------------------
// createMemory
// ---------------------------------------------------------------------------

describe("createMemory", () => {
  it("persists a memory and returns it with generated id", async () => {
    const entry = await createMemory(db, {
      content: "The auth system uses JWT tokens",
      tags: ["auth", "security"],
      timestamp: Date.now(),
      sessionId: null,
    });

    expect(entry.id).toBeDefined();
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.content).toBe("The auth system uses JWT tokens");
    expect(entry.tags).toEqual(["auth", "security"]);
    expect(entry.timestamp).toBeGreaterThan(0);
    expect(entry.sessionId).toBeNull();
    expect(entry.importance).toBe(1.0);
    expect(entry.accessCount).toBe(0);
    expect(entry.lastAccessed).toBeNull();
  });

  it("persists a memory with a session id", async () => {
    const [session] = await db.db
      .insert(schema.sessions)
      .values({ title: "Test Session" })
      .returning()
      .execute();

    const entry = await createMemory(db, {
      content: "User prefers dark mode",
      tags: ["preferences", "ui"],
      timestamp: Date.now(),
      sessionId: session.id,
    });

    expect(entry.sessionId).toBe(session.id);
  });

  it("respects a caller-provided id", async () => {
    const customId = crypto.randomUUID();
    const entry = await createMemory(db, {
      id: customId,
      content: "Custom id memory",
      tags: ["test"],
      timestamp: Date.now(),
      sessionId: null,
    });

    expect(entry.id).toBe(customId);
  });

  it("respects custom importance", async () => {
    const entry = await createMemory(db, {
      content: "High importance memory",
      tags: ["critical"],
      timestamp: Date.now(),
      sessionId: null,
      importance: 0.5,
    });

    expect(entry.importance).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// searchMemory
// ---------------------------------------------------------------------------

describe("searchMemory", () => {
  beforeAll(async () => {
    // Seed test data.
    await createMemory(db, {
      content: "The project uses PGLite for local storage",
      tags: ["database", "pglite"],
      timestamp: Date.now(),
      sessionId: null,
    });
    await createMemory(db, {
      content: "Auth uses JWT tokens with refresh rotation",
      tags: ["auth", "jwt", "security"],
      timestamp: Date.now() - 1000,
      sessionId: null,
    });
    await createMemory(db, {
      content: "The frontend uses React 19 with TanStack Query",
      tags: ["frontend", "react"],
      timestamp: Date.now() - 2000,
      sessionId: null,
    });
  });

  it("finds memories by content substring (case-insensitive)", async () => {
    const results = await searchMemory(db, "pglite");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m) => m.content.includes("PGLite"))).toBe(true);
  });

  it("finds memories by tag substring", async () => {
    const results = await searchMemory(db, "security");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(
      results.some((m) =>
        m.tags.some((t) => t.toLowerCase().includes("security")),
      ),
    ).toBe(true);
  });

  it("returns results with decay scores (newer = higher)", async () => {
    const results = await searchMemory(db, "uses");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // All results should have decay scores via the scoring function.
    for (const r of results) {
      const score = scoreMemory(r);
      expect(score).toBeGreaterThan(0);
    }
  });

  it("respects limit option", async () => {
    const results = await searchMemory(db, "uses", { limit: 1 });
    expect(results.length).toBe(1);
  });

  it("returns empty array for no matches", async () => {
    const results = await searchMemory(db, "xyznonexistent");
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// injectMemory
// ---------------------------------------------------------------------------

describe("injectMemory", () => {
  const makeMsg = (role: Message["role"], text: string): Message => ({
    id: crypto.randomUUID(),
    role,
    content: text,
    createdAt: Date.now(),
  });

  it("returns original messages when memories are empty", () => {
    const messages = [makeMsg("user", "hello")];
    const result = injectMemory(messages, []);
    expect(result).toEqual(messages);
  });

  it("prepends memory system message before first user message", () => {
    const messages = [
      makeMsg("system", "You are helpful"),
      makeMsg("user", "hello"),
    ];
    const memories = [
      {
        id: "1",
        content: "User likes TypeScript",
        tags: ["lang"],
        timestamp: Date.now(),
        sessionId: null,
        importance: 1.0,
        accessCount: 0,
        lastAccessed: null,
      },
    ];

    const result = injectMemory(messages, memories);

    expect(result.length).toBe(3);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("system");
    expect(result[2].role).toBe("user");

    const memContent =
      typeof result[1].content === "string"
        ? result[1].content
        : result[1].content
            .filter((p): p is { _tag: "text"; text: string } => p._tag === "text")
            .map((p) => p.text)
            .join("");
    expect(memContent).toContain("User likes TypeScript");
    expect(memContent).toContain("<recalled-memories>");
  });

  it("inserts memory after leading system messages", () => {
    const messages = [
      makeMsg("system", "System 1"),
      makeMsg("system", "System 2"),
      makeMsg("user", "hello"),
      makeMsg("assistant", "hi"),
    ];
    const memories = [
      {
        id: "1",
        content: "Recalled fact",
        tags: [],
        timestamp: Date.now(),
        sessionId: null,
        importance: 1.0,
        accessCount: 0,
        lastAccessed: null,
      },
    ];

    const result = injectMemory(messages, memories);

    expect(result.length).toBe(5);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("system");
    expect(result[2].role).toBe("system"); // injected memory
    expect(result[3].role).toBe("user");
    expect(result[4].role).toBe("assistant");
  });

  it("does not mutate the original array", () => {
    const messages = [makeMsg("user", "hello")];
    const memories = [
      {
        id: "1",
        content: "Recalled",
        tags: [],
        timestamp: Date.now(),
        sessionId: null,
        importance: 1.0,
        accessCount: 0,
        lastAccessed: null,
      },
    ];

    const originalLength = messages.length;
    injectMemory(messages, memories);
    expect(messages.length).toBe(originalLength);
  });

  it("includes decay score in memory message", () => {
    const messages = [makeMsg("user", "hello")];
    const memories = [
      {
        id: "1",
        content: "Test memory",
        tags: ["test"],
        timestamp: Date.now(),
        sessionId: null,
        importance: 1.0,
        accessCount: 3,
        lastAccessed: null,
      },
    ];

    const result = injectMemory(messages, memories);
    const memContent =
      typeof result[0].content === "string"
        ? result[0].content
        : result[0].content
            .filter((p): p is { _tag: "text"; text: string } => p._tag === "text")
            .map((p) => p.text)
            .join("");
    expect(memContent).toContain("score:");
  });
});

// ---------------------------------------------------------------------------
// recallAndInject
// ---------------------------------------------------------------------------

describe("recallAndInject", () => {
  beforeAll(async () => {
    await createMemory(db, {
      content: "The project uses PGLite for local storage",
      tags: ["database"],
      timestamp: Date.now(),
      sessionId: null,
    });
  });

  it("returns original messages when no user message exists", async () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "system",
        content: "System prompt",
        createdAt: Date.now(),
      },
    ];
    const result = await recallAndInject(db, messages);
    expect(result).toEqual(messages);
  });

  it("injects relevant memories based on last user message", async () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: "How does PGLite work?",
        createdAt: Date.now(),
      },
    ];

    const result = await recallAndInject(db, messages);
    expect(result.length).toBe(2);
    expect(result[0].role).toBe("system"); // injected memory
    expect(result[1].role).toBe("user");
  });

  it("returns original messages when query has no matches", async () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: "xyzzyplugh12345 unique_nomatch",
        createdAt: Date.now(),
      },
    ];

    const result = await recallAndInject(db, messages);
    expect(result.length).toBe(1);
    expect(result[0].role).toBe("user");
  });

  it("handles array content in user message", async () => {
    const messages: Message[] = [
      {
        id: "1",
        role: "user",
        content: [
          { _tag: "text", text: "What about the PGLite storage?" },
        ],
        createdAt: Date.now(),
      },
    ];

    const result = await recallAndInject(db, messages);
    expect(result.length).toBe(2);
    expect(result[0].role).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// Decay scoring
// ---------------------------------------------------------------------------

describe("scoreMemory", () => {
  it("returns ~1.0 for a brand new memory", () => {
    const entry = {
      id: "1",
      content: "test",
      tags: [],
      timestamp: Date.now(),
      sessionId: null,
      importance: 1.0,
      accessCount: 0,
      lastAccessed: null,
    };
    const score = scoreMemory(entry, Date.now());
    expect(score).toBeCloseTo(1.0, 1);
  });

  it("returns a lower score for an old memory", () => {
    const now = Date.now();
    const old = {
      id: "1",
      content: "test",
      tags: [],
      timestamp: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
      sessionId: null,
      importance: 1.0,
      accessCount: 0,
      lastAccessed: null,
    };
    const score = scoreMemory(old, now);
    expect(score).toBeLessThan(0.5);
  });

  it("boosts score for frequently accessed memories", () => {
    const now = Date.now();
    const base = {
      id: "1",
      content: "test",
      tags: [],
      timestamp: now - 30 * 24 * 60 * 60 * 1000,
      sessionId: null,
      importance: 1.0,
      accessCount: 0,
      lastAccessed: null,
    };
    const accessed = { ...base, accessCount: 10 };

    const baseScore = scoreMemory(base, now);
    const accessedScore = scoreMemory(accessed, now);
    expect(accessedScore).toBeGreaterThan(baseScore);
  });

  it("never goes below minScore", () => {
    const now = Date.now();
    const ancient = {
      id: "1",
      content: "test",
      tags: [],
      timestamp: now - 365 * 24 * 60 * 60 * 1000, // 1 year
      sessionId: null,
      importance: 0.1,
      accessCount: 0,
      lastAccessed: null,
    };
    const score = scoreMemory(ancient, now);
    expect(score).toBeGreaterThanOrEqual(0.05);
  });

  it("respects custom decay config", () => {
    const now = Date.now();
    const entry = {
      id: "1",
      content: "test",
      tags: [],
      timestamp: now - 7 * 24 * 60 * 60 * 1000, // 7 days
      sessionId: null,
      importance: 1.0,
      accessCount: 0,
      lastAccessed: null,
    };

    // With 1-day half-life, 7 days = 3 half-lives => factor ~0.125
    const shortHalfLife = scoreMemory(entry, now, {
      halfLifeMs: 24 * 60 * 60 * 1000,
      minScore: 0.05,
      accessBoost: 0.15,
    });

    // With 30-day half-life, 7 days = ~0.23 half-lives => factor ~0.85
    const longHalfLife = scoreMemory(entry, now, {
      halfLifeMs: 30 * 24 * 60 * 60 * 1000,
      minScore: 0.05,
      accessBoost: 0.15,
    });

    expect(longHalfLife).toBeGreaterThan(shortHalfLife);
  });
});

describe("applyDecay", () => {
  it("sorts memories by decay score descending", () => {
    const now = Date.now();
    const entries = [
      {
        id: "old",
        content: "old",
        tags: [],
        timestamp: now - 60 * 24 * 60 * 60 * 1000,
        sessionId: null,
        importance: 1.0,
        accessCount: 0,
        lastAccessed: null,
      },
      {
        id: "new",
        content: "new",
        tags: [],
        timestamp: now,
        sessionId: null,
        importance: 1.0,
        accessCount: 0,
        lastAccessed: null,
      },
    ];

    const scored = applyDecay(entries, now);
    expect(scored[0].id).toBe("new");
    expect(scored[0].decayScore).toBeGreaterThan(scored[1].decayScore);
  });
});

// ---------------------------------------------------------------------------
// touchMemory
// ---------------------------------------------------------------------------

describe("touchMemory", () => {
  it("increments access count and updates last_accessed", async () => {
    const entry = await createMemory(db, {
      content: "Unique touch test memory qwertyuiop_789",
      tags: ["touch"],
      timestamp: Date.now(),
      sessionId: null,
    });

    expect(entry.accessCount).toBe(0);
    expect(entry.lastAccessed).toBeNull();

    await touchMemory(db, entry.id);

    // Re-read from DB by direct query to avoid multi-match from other tests.
    const rows = await db.db
      .select()
      .from(schema.memories)
      .where(require("drizzle-orm").eq(schema.memories.id, entry.id))
      .execute();
    expect(rows.length).toBe(1);
    expect(rows[0].accessCount).toBe(1);
    expect(rows[0].lastAccessed).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------

describe("createAssociation", () => {
  it("creates a directed association between two memories", async () => {
    const a = await createMemory(db, {
      content: "TypeScript is strongly typed",
      tags: ["typescript", "lang"],
      timestamp: Date.now(),
      sessionId: null,
    });
    const b = await createMemory(db, {
      content: "TypeScript compiles to JavaScript",
      tags: ["typescript", "javascript"],
      timestamp: Date.now(),
      sessionId: null,
    });

    const assoc = await createAssociation(db, a.id, b.id, "related", 0.8);
    expect(assoc.sourceId).toBe(a.id);
    expect(assoc.targetId).toBe(b.id);
    expect(assoc.relation).toBe("related");
    expect(assoc.strength).toBe(0.8);
  });

  it("deduplicates by (sourceId, targetId)", async () => {
    const a = await createMemory(db, {
      content: "Dedup test A",
      tags: [],
      timestamp: Date.now(),
      sessionId: null,
    });
    const b = await createMemory(db, {
      content: "Dedup test B",
      tags: [],
      timestamp: Date.now(),
      sessionId: null,
    });

    await createAssociation(db, a.id, b.id, "similar", 0.5);
    const second = await createAssociation(db, a.id, b.id, "similar", 0.9);

    // Should update strength to max, not create a new row.
    expect(second.strength).toBe(0.9);
  });
});

describe("getAssociations", () => {
  it("returns associations for a memory", async () => {
    const memA = await createMemory(db, {
      content: "Assoc get test A",
      tags: [],
      timestamp: Date.now(),
      sessionId: null,
    });
    const memB = await createMemory(db, {
      content: "Assoc get test B",
      tags: [],
      timestamp: Date.now(),
      sessionId: null,
    });

    await createAssociation(db, memA.id, memB.id, "similar", 0.7);

    const assocs = await getAssociations(db, memA.id);
    expect(assocs.length).toBeGreaterThanOrEqual(1);
    expect(assocs.some((x) => x.sourceId === memA.id || x.targetId === memA.id)).toBe(true);
  });
});

describe("autoAssociate", () => {
  it("creates associations for similar memories", async () => {
    const a = await createMemory(db, {
      content: "The project uses React for the frontend",
      tags: ["react", "frontend"],
      timestamp: Date.now(),
      sessionId: null,
    });
    const b = await createMemory(db, {
      content: "The project uses React with TypeScript",
      tags: ["react", "typescript"],
      timestamp: Date.now(),
      sessionId: null,
    });
    // A dissimilar memory should NOT be linked.
    await createMemory(db, {
      content: "Database uses PostgreSQL with pgvector",
      tags: ["database", "postgresql"],
      timestamp: Date.now(),
      sessionId: null,
    });

    const count = await autoAssociate(db, a.id, 0.3);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

describe("compressMemories", () => {
  it("merges memories into one and archives originals", async () => {
    const a = await createMemory(db, {
      content: "The auth module uses JWT",
      tags: ["auth", "jwt"],
      timestamp: Date.now() - 1000,
      sessionId: null,
    });
    const b = await createMemory(db, {
      content: "Auth uses refresh token rotation",
      tags: ["auth", "security"],
      timestamp: Date.now(),
      sessionId: null,
    });

    const merged = await compressMemories(
      db,
      [a.id, b.id],
      "Auth module: uses JWT with refresh token rotation",
      ["auth", "jwt", "security"],
    );

    expect(merged.id).toBeDefined();
    expect(merged.content).toBe("Auth module: uses JWT with refresh token rotation");
    expect(merged.tags).toContain("auth");
    expect(merged.importance).toBeGreaterThanOrEqual(1.0);

    // Originals should have compressed-to tag.
    const [rowA] = await db.db
      .select()
      .from(schema.memories)
      .where(require("drizzle-orm").eq(schema.memories.id, a.id))
      .execute();
    const tagsA = Array.isArray(rowA.tags)
      ? (rowA.tags as string[])
      : JSON.parse(rowA.tags as string);
    expect(tagsA.some((t: string) => t.startsWith("compressed-to:"))).toBe(true);
  });
});

describe("autoCompress", () => {
  it("compresses highly similar memory pairs", async () => {
    const a = await createMemory(db, {
      content: "The API gateway handles routing and rate limiting",
      tags: ["api", "gateway"],
      timestamp: Date.now(),
      sessionId: null,
    });
    const b = await createMemory(db, {
      content: "API gateway manages routing and rate limiting policies",
      tags: ["api", "gateway", "routing"],
      timestamp: Date.now(),
      sessionId: null,
    });

    const count = await autoCompress(db, 0.4);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

describe("exportMemories", () => {
  it("exports memories as a JSON payload", async () => {
    const payload = await exportMemories(db);
    expect(payload.version).toBe(1);
    expect(payload.exportedAt).toBeGreaterThan(0);
    expect(payload.memories.length).toBeGreaterThan(0);
    expect(payload.memories[0].content).toBeDefined();
    expect(payload.memories[0].contentHash).toBeDefined();
  });

  it("filters by sessionId", async () => {
    const [session] = await db.db
      .insert(schema.sessions)
      .values({ title: "Export Test" })
      .returning()
      .execute();

    await createMemory(db, {
      content: "Session-scoped memory for export",
      tags: ["export"],
      timestamp: Date.now(),
      sessionId: session.id,
    });

    const payload = await exportMemories(db, { sessionId: session.id });
    expect(
      payload.memories.every((m) => m.content.includes("export")),
    ).toBe(true);
  });
});

describe("importMemories", () => {
  it("imports memories from a payload", async () => {
    const payload = {
      version: 1 as const,
      exportedAt: Date.now(),
      memories: [
        {
          content: "Imported memory: the sky is blue",
          tags: ["nature", "import"],
          timestamp: Date.now(),
          importance: 0.9,
          contentHash: "imported_hash_1",
        },
      ],
      associations: [],
    };

    const result = await importMemories(db, payload, { deduplicate: false });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("skips duplicates when deduplicate is true", async () => {
    const content = "Duplicate detection test unique_content_xyz";
    await createMemory(db, {
      content,
      tags: [],
      timestamp: Date.now(),
      sessionId: null,
    });

    const payload = {
      version: 1 as const,
      exportedAt: Date.now(),
      memories: [
        {
          content,
          tags: [],
          timestamp: Date.now(),
          importance: 1.0,
          contentHash: "dup_hash",
        },
      ],
      associations: [],
    };

    const result = await importMemories(db, payload, { deduplicate: true });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("imports associations between imported memories", async () => {
    const payload = {
      version: 1 as const,
      exportedAt: Date.now(),
      memories: [
        {
          content: "Assoc import A unique_content_alpha",
          tags: ["import"],
          timestamp: Date.now(),
          importance: 1.0,
          contentHash: "assoc_a",
        },
        {
          content: "Assoc import B unique_content_beta",
          tags: ["import"],
          timestamp: Date.now(),
          importance: 1.0,
          contentHash: "assoc_b",
        },
      ],
      associations: [
        {
          sourceContentHash: "assoc_a",
          targetContentHash: "assoc_b",
          relation: "similar",
          strength: 0.75,
        },
      ],
    };

    const result = await importMemories(db, payload, { deduplicate: false });
    expect(result.imported).toBe(2);
    expect(result.associationsImported).toBe(1);
  });
});
