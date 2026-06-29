// hashline 补丁语言（spec §16）：内容哈希锚定的行级补丁。
// BLK 语法块操作待 AST 工具后续迭代。

export type { ApplyResult, ParsedPatch, PatchOp } from './patch.js'
export { applyPatch, computeHash, parsePatch } from './patch.js'
