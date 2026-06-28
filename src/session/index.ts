// Session layer: conversation persistence, branching, compaction, and context reconstruction.

export {
  archiveOriginalEntries,
  getArchive,
  getArchiveOriginalEntries,
  parseArchiveReference,
  resolveArchiveReference,
  searchArchives,
} from './archive.js'
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
  messageToChatMessage,
} from './context.js'
export {
  appendMessage,
  deleteEntriesByIds,
  deleteMessagesAfter,
  getEntries,
  getMessageCount,
  getMessages,
  insertEntry,
} from './message.js'
export {
  appendLLMDetail,
  createSession,
  deleteSession,
  getLLMDetails,
  getSession,
  listSessions,
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
