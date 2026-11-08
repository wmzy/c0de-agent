// generateId 收敛到 shared 单一实现（globalThis.crypto.randomUUID + 退化兜底），
// 浏览器与 node 输出一致；web 侧调用方沿用 '@/hooks/id.js' 导入路径不变。
export { generateId } from '@shared/utils.js'
