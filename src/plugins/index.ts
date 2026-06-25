// Plugins package public API (§7).
//
// Re-exports every type and function the rest of the codebase is allowed to
// depend on. Internal helpers (private to each file) are not re-exported.
//
// Conventions: data + functions, no class.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  HookHandler,
  HookMap,
  Plugin,
  PluginContext,
  PluginLogger,
  PluginRegistry,
} from "./types";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export {
  createPluginRegistry,
  getPlugin,
  listPlugins,
  registerPlugin,
} from "./registry";

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export { registerHook, runHooks } from "./hooks";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export { activatePlugin, discoverPlugins, loadPlugin } from "./loader";
export type { PluginSource } from "./loader";

// ---------------------------------------------------------------------------
// Lifecycle (§7.1)
// ---------------------------------------------------------------------------

export {
  activatePlugin as lifecycleActivatePlugin,
  createLifecycleManager,
  deactivateAll,
  deactivatePlugin,
  getPluginStatus,
  isPluginActive,
  loadAndActivate,
} from "./lifecycle";
export type { DeactivateResult, LifecycleManager, PluginStatus } from "./lifecycle";

// ---------------------------------------------------------------------------
// Team Mailbox
// ---------------------------------------------------------------------------

export type { MailboxMessage } from "./mailbox";
export {
  clearMailbox,
  drainMailbox,
  formatMailboxContext,
  getMailboxSize,
  listAllMailbox,
  markAsRead,
  receiveMailbox,
  sendMailbox,
} from "./mailbox";

// ---------------------------------------------------------------------------
// Directory Agents (§7.5)
// ---------------------------------------------------------------------------

export type { DirectoryAgent } from "./directory-agents";
export {
  discoverDirectoryAgents,
  getDirectoryAgent,
  injectDirectoryAgents,
} from "./directory-agents";

// ---------------------------------------------------------------------------
// Session Notifications
// ---------------------------------------------------------------------------

export type { Notification, NotificationFilter, NotificationType } from "./session-notification";
export {
  clearAll as clearAllNotifications,
  clearSession,
  createSessionNotificationPlugin,
  drainNotifications,
  formatNotificationsContext,
  getNotifications,
  getUnreadCount,
  listAllSessions,
  markAllAsRead,
  markAsRead as markNotificationAsRead,
  notifyCompaction,
  notifyError,
  notifySessionEnd,
  notifySessionStart,
  notifyToolComplete,
  notifyToolError,
  sendNotification,
} from "./session-notification";

// ---------------------------------------------------------------------------
// Compaction Context Injector
// ---------------------------------------------------------------------------

export type { ContextCapture, MessageLike as CompactionMessageLike } from "./compaction-context-injector";
export {
  buildContextInjection,
  createCompactionContextPlugin,
  extractContext,
  injectCompactionContext,
} from "./compaction-context-injector";

// ---------------------------------------------------------------------------
// Compaction Todo Preserver
// ---------------------------------------------------------------------------

export type { TodoCapture, TodoItem } from "./compaction-todo-preserver";
export {
  buildTodoInjection,
  createCompactionTodoPreserverPlugin,
  extractTodos,
  preserveTodosInCompaction,
} from "./compaction-todo-preserver";

// ---------------------------------------------------------------------------
// Hindsight
// ---------------------------------------------------------------------------

export type { HindsightEntry, HindsightQuery } from "./hindsight";
export {
  clearHindsight,
  createHindsightPlugin,
  getHindsight,
  getSessionEntries,
  recordHindsight,
  setHindsightSession,
} from "./hindsight";
