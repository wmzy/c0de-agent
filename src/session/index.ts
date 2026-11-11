// Session layer: conversation persistence, branching, compaction, and context reconstruction.

export { archiveOriginalEntries, getArchive, searchArchives } from './archive.js'
export { forkSession, getBranches, getTree } from './branch.js'
export {
  buildCompactionPrompt,
  compactSession,
  extractHotFiles,
  findSafeCutPoint,
} from './compaction.js'
export {
  entriesToChatMessages,
  getSessionContext,
  injectSnapshots,
  messageToChatMessages,
} from './context.js'
export {
  appendMessage,
  deleteEntriesByIds,
  getEntries,
  getMessageCount,
  getMessages,
  insertEntry,
  summaryEntryTimestamp,
  updateEntryContent,
} from './message.js'
export {
  getLLMSegments,
  migrateLegacyDetails,
  saveLLMSegments,
  segmentFingerprint,
} from './segments.js'
export {
  consumeBudgetPauseMarker,
  createSession,
  getSession,
  listSessions,
  markBudgetPause,
  touchSession,
  updateSessionTitle,
} from './session.js'
export {
  checkFileSnapshot,
  getFileSnapshots,
  getLatestFileSnapshot,
  upsertFileSnapshot,
} from './snapshot.js'
export { squashRecent } from './squash.js'
export { estimateMessageTokens, estimateTokens } from './token.js'
export {
  emptyTrash,
  listDeletedSessions,
  permanentlyDeleteSession,
  purgeDeletedSessions,
  restoreSession,
  restoreSessionCore,
  softDeleteSession,
  TRASH_RETENTION_MS,
  touchTrashSeen,
} from './trash.js'
export type {
  ArchiveRef,
  BranchSummaryEntry,
  CompactionArchive,
  CompactionConfig,
  CompactionEntry,
  CompactionResult,
  FileSnapshot,
  HotFile,
  MessageInput,
  SessionEntry,
  SessionTreeNode,
  SquashConfig,
  SquashEntry,
  SteeringEntry,
  Summarizer,
} from './types.js'
