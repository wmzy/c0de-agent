// 记忆包门面：宿主接线（chat/print/server/tools）只 import 这里。
// 内部模块间仍走相对导入，此文件不引入新逻辑。

export type { SharpshooterBackend } from './backend.js'
export { createSharpshooterBackend, startScheduler } from './backend.js'
export type { ConsolidationResult } from './consolidate.js'
export {
  consecutiveFailures,
  consolidationMaxTokens,
  nextConsolidationAt,
  REPLACE_MEMORY_FILES_TOOL,
  renderSessions,
  runConsolidation,
  truncateApproxTokens,
} from './consolidate.js'
export type { MemoryMessage, SharpshooterEnvelope } from './extract.js'
export {
  admitDelta,
  buildExtractionEnvelope,
  cleanEnvelopeContext,
  countGraphemes,
  passesExtractionGate,
  RECORD_DELTAS_TOOL,
  runExtraction,
} from './extract.js'
export type { LearnedEntry } from './learn.js'
export {
  createLearnTool,
  LEARNED_CONTEXT_LIMIT,
  LEARNED_FILE,
  LEARNED_MAX_ENTRIES,
  LEARNED_MEMORY_LIMIT,
  mergeLearned,
  neutralizeInjection,
  normalizeLearnedKey,
  parseLearned,
  renderLearned,
} from './learn.js'
export type {
  MemoryLlmCall,
  MemoryLlmConfig,
  MemoryToolCall,
  MemoryToolCallResult,
} from './llm-call.js'
export { callToolRequired, resolveMemoryModel } from './llm-call.js'
export {
  EXTRACT_SYSTEM_PROMPT,
  renderConsolidateInput,
  renderConsolidateSystem,
  renderExtractInput,
} from './prompts.js'
export type { MemorySettings, SharpshooterSettings } from './settings.js'
export { resolveMemorySettings } from './settings.js'
export type { BankLock, QueuedDelta, SharpshooterSessionDeltas } from './storage.js'
export {
  acquireBankLock,
  appendDelta,
  bankDir,
  consumeDeltas,
  listDeltas,
  memoryFilePath,
  projectBankSegment,
  queueDepth,
  queueDir,
  readState,
  sanitizeSessionId,
  sharpshooterRoot,
  writeState,
} from './storage.js'
export type {
  SharpshooterDelta,
  SharpshooterDeltaKind,
  SharpshooterDeltaSource,
  SharpshooterFriction,
  SharpshooterMemoryFile,
  SharpshooterState,
} from './types.js'
export {
  SHARPSHOOTER_MAX_FILE_LINES,
  SHARPSHOOTER_MEMORY_FILES,
} from './types.js'
