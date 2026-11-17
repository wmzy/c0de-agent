// 代理对安全的字符截断工具。
//
// UTF-16 下 emoji 等 astral 字符占两个码元（高代理 + 低代理）。直接 slice 会把
// 代理对切成两半，产出孤立代理码元——经 JSON 序列化/UTF-8 编码往返后损坏为
// U+FFFD（输出内容被静默改写）。所有「按字符数截断」的调用点都应经本模块
// 把切点内收到安全边界。

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/** 切点把代理对拆开时向左内收（丢弃悬空高代理码元）。 */
function safeHeadEnd(text: string, end: number): number {
  while (
    end > 0 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    end--
  }
  return end
}

/** 切点把代理对拆开时向右内收（跳过悬空低代理码元）。 */
function safeTailStart(text: string, start: number): number {
  while (
    start > 0 &&
    start < text.length &&
    isHighSurrogate(text.charCodeAt(start - 1)) &&
    isLowSurrogate(text.charCodeAt(start))
  ) {
    start++
  }
  return start
}

/** 取至多 n 字符的前缀；切点绝不在代理对中间。n ≥ 文本长度时原样返回。 */
export function headChars(text: string, n: number): string {
  if (n <= 0) return ''
  if (n >= text.length) return text
  return text.slice(0, safeHeadEnd(text, n))
}

/** 取至多 n 字符的后缀；切点绝不在代理对中间。n ≥ 文本长度时原样返回。 */
export function tailChars(text: string, n: number): string {
  if (n <= 0) return ''
  if (n >= text.length) return text
  return text.slice(safeTailStart(text, text.length - n))
}

/** 截断到 max 内且省略号计入上限：text 超长时取前 max-ellipsis.length 字符 +
 *  ellipsis。切点经 headChars 内收，不拆代理对（会话标题与 PTY 标题两处
 *  truncateTitle 的同形骨架收敛；省略号形态/长度是调用点口径）。 */
export function truncateHead(text: string, max: number, ellipsis: string): string {
  return text.length > max ? headChars(text, max - ellipsis.length) + ellipsis : text
}

/** 正则元字符逐字符转义（转出可安全嵌入 RegExp 的字面量原文）。
 *  glob（非法字符类/花括号降级）与 grep（非法模式的字面量回退）共用。 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 任意抛出值 → 可读错误消息：Error 取 message，其余 String() 兜底。
 *  `e instanceof Error ? e.message : String(e)` 骨架的单一实现（core/tools/
 *  llm/mcp 各 catch 分支共用）——各处手写曾反复漂移（漏 String 兜底、模板里
 *  隐式 coercion 等），收紧兜底语义时只改这一处。 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** UUID（任意版本/大小写）格式判定。
 *  用于「路径/参数里的 id 直接进 PG uuid 列」的入口预检：非 UUID 经 drizzle
 *  参数化查询会在 PG 侧抛 22P02（invalid input syntax for type uuid），被 Hono
 *  兜成 500 并把 SQL 错误细节回给客户端——入口显式判非法（404）即可避免。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
