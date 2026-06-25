// Todo status tracking (inspired by OpenCode's session todo feature).
//
// Data + functions paradigm: TodoItem is a plain type, CRUD functions take
// a DB handle as first parameter.
//
// Auto-detection scans assistant response text for TODO patterns:
//   - Markdown checkbox items: "- [ ] task" or "- [x] task"
//   - Inline annotations: "TODO:", "FIXME:", "HACK:", "XXX:"

import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { sessions, todos } from "../db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";
export type TodoPriority = "low" | "medium" | "high";

/** A tracked todo item within a session. */
export type TodoItem = {
  id: string;
  sessionId: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  context: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new todo item for the given session.
 */
export async function createTodo(
  db: DB,
  sessionId: string,
  item: {
    content: string;
    status?: TodoStatus;
    priority?: TodoPriority;
    context?: string | null;
  },
): Promise<TodoItem> {
  const now = new Date();
  const [row] = await db.db
    .insert(todos)
    .values({
      id: crypto.randomUUID(),
      sessionId,
      content: item.content,
      status: item.status ?? "pending",
      priority: item.priority ?? "medium",
      context: item.context ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Touch parent session timestamp
  await db.db.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId));

  return row as unknown as TodoItem;
}

/**
 * Update an existing todo item's status.
 */
export async function updateTodo(db: DB, todoId: string, status: TodoStatus): Promise<void> {
  const now = new Date();
  await db.db.update(todos).set({ status, updatedAt: now }).where(eq(todos.id, todoId));
}

/**
 * Update an existing todo item's priority.
 */
export async function updateTodoPriority(
  db: DB,
  todoId: string,
  priority: TodoPriority,
): Promise<void> {
  const now = new Date();
  await db.db.update(todos).set({ priority, updatedAt: now }).where(eq(todos.id, todoId));
}

/**
 * List all todos for a session, most recently updated first.
 */
export async function listTodos(db: DB, sessionId: string): Promise<TodoItem[]> {
  const rows = await db.db
    .select()
    .from(todos)
    .where(eq(todos.sessionId, sessionId))
    .orderBy(desc(todos.updatedAt));
  return rows as unknown as TodoItem[];
}

/**
 * List todos filtered by status.
 */
export async function listTodosByStatus(
  db: DB,
  sessionId: string,
  status: TodoStatus,
): Promise<TodoItem[]> {
  const rows = await db.db
    .select()
    .from(todos)
    .where(and(eq(todos.sessionId, sessionId), eq(todos.status, status)))
    .orderBy(desc(todos.updatedAt));
  return rows as unknown as TodoItem[];
}

/**
 * Delete a todo item.
 */
export async function deleteTodo(db: DB, todoId: string): Promise<void> {
  await db.db.delete(todos).where(eq(todos.id, todoId));
}

/**
 * Get a single todo by id.
 */
export async function getTodo(db: DB, todoId: string): Promise<TodoItem | null> {
  const [row] = await db.db.select().from(todos).where(eq(todos.id, todoId)).limit(1);
  return (row as unknown as TodoItem) ?? null;
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

/** Regex matching markdown checkbox items at line start (with optional indent). */
const MARKDOWN_TODO_REGEX = /^([ \t]*)[-*] \[([ xX])\] (.+)$/gm;

/** Regex matching inline annotation prefixes like TODO, FIXME, HACK, XXX. */
const INLINE_TODO_REGEX = /\b(TODO|FIXME|HACK|XXX)[\s:;]\s*(.+)$/gim;

/** Mapping of detected markdown checkbox state to TodoStatus. */
function checkboxToStatus(checked: string): TodoStatus {
  return checked.toLowerCase() === "x" ? "done" : "pending";
}

/** Mapping of inline annotation keyword to priority. */
function annotationToPriority(keyword: string): TodoPriority {
  switch (keyword.toUpperCase()) {
    case "FIXME":
    case "HACK":
      return "high";
    case "TODO":
      return "medium";
    case "XXX":
      return "low";
    default:
      return "medium";
  }
}

/** Estimate priority from content keywords for markdown items. */
function contentPriority(content: string): TodoPriority {
  const lower = content.toLowerCase();
  if (/critical|urgent|blocker|important|fixme|hack/i.test(lower)) return "high";
  if (/nice.to.have|optional|maybe|consider|low/i.test(lower)) return "low";
  return "medium";
}

/**
 * Extract TODO items from a text string.
 * Returns an array of { content, status, priority } tuples.
 */
export function extractTodosFromText(
  text: string,
): Array<{ content: string; status: TodoStatus; priority: TodoPriority }> {
  const items: Array<{ content: string; status: TodoStatus; priority: TodoPriority }> = [];
  const seen = new Set<string>();

  // 1. Scan for markdown checkbox items
  let match: RegExpExecArray | null;
  MARKDOWN_TODO_REGEX.lastIndex = 0;
  while ((match = MARKDOWN_TODO_REGEX.exec(text)) !== null) {
    const content = match[3].trim();
    const dedupKey = content.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    items.push({
      content,
      status: checkboxToStatus(match[2]),
      priority: contentPriority(content),
    });
  }

  // 2. Scan for inline annotations (TODO:, FIXME:, etc.)
  INLINE_TODO_REGEX.lastIndex = 0;
  while ((match = INLINE_TODO_REGEX.exec(text)) !== null) {
    const content = match[2].trim();
    const dedupKey = `inline:${match[1].toUpperCase()}:${content.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    items.push({
      content: `${match[1]}: ${content}`,
      status: "pending",
      priority: annotationToPriority(match[1]),
    });
  }

  return items;
}

/**
 * Detect TODOs in response text and persist them to the database.
 * Returns the number of newly created todo items.
 */
export async function autoDetectTodosFromResponse(
  db: DB,
  sessionId: string,
  responseText: string,
): Promise<number> {
  // Get existing todo content strings for deduplication
  const existing = await listTodos(db, sessionId);
  const existingContent = new Set(existing.map((t) => t.content.toLowerCase().trim()));

  const detected = extractTodosFromText(responseText);
  let created = 0;

  for (const item of detected) {
    const normalized = item.content.toLowerCase().trim();
    if (existingContent.has(normalized)) continue;
    existingContent.add(normalized);

    await createTodo(db, sessionId, {
      content: item.content,
      status: item.status ?? undefined,
      priority: item.priority ?? undefined,
      context: "auto-detected",
    });
    created++;
  }

  return created;
}