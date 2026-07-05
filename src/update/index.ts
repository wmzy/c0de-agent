// 热更新 + 会话迁移包（spec §18）。

export type { HandoffServer } from './ipc.js'
export { createHandoffServer, requestHandoff } from './ipc.js'
export type { UpdateScheduler, UpdateSchedulerOptions } from './scheduler.js'
export { createUpdateScheduler } from './scheduler.js'
export type { SerializedEntry, SerializedSession, SessionSnapshot } from './snapshot.js'
export { orderSessionsByParent, restoreSessions, serializeSessions } from './snapshot.js'
export type { HotUpdateOptions, HotUpdateResult, SpawnFn } from './updater.js'
export { cleanupSnapshot, performHotUpdate } from './updater.js'
export type { UpdateCheckResult } from './version.js'
export { checkForUpdate, compareSemver } from './version.js'
