// 终端 WS 通道上的服务端控制消息判定（纯函数，供 Terminal.tsx 与单测共用）。
//
// 控制帧与 PTY 输出**共用同一条 WebSocket 字节流**，服务端只发两种规范形状
// （见 server/terminal/pty-manager.ts 与 server/server.ts）：
//   - {"type":"exit","exitCode":<number>}   进程退出/被杀
//   - {"type":"error","message":"<string>"} 挂载 WS 时终端不存在
//
// 判定必须严格限定在规范形状。此前 Terminal.tsx 用
// `data.startsWith('{') && data.includes('"type"')` + JSON.parse 后看 type 字段：
// 任何以 `{` 开头、含 `"type"` 且能解析的**终端输出**（curl/jq/`cat` 一条 JSON、
// 程序自己打印 `{"type":"exit",...}`）都被当成控制消息——真实输出被整条吞掉，
// 界面凭空显示「[Process exited with code …]」/「[Error: …]」。

/** 服务端控制消息（判定通过后的判别联合）。 */
export type TerminalControlMessage =
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }

/**
 * 把一条 WS 文本帧解析为服务端控制消息；非规范控制帧返回 null（调用方按
 * 终端输出原样写入）。
 *
 * 严格性来自三层：
 *  1. `JSON.stringify(parsed) === data` —— 帧必须逐字符等于解析结果的重序列化
 *     （排除空白/换行/尾随字符变体）；
 *  2. 键集恰为规范字段、首键必须为 `type` 且值类型精确——服务端由
 *     `JSON.stringify({ type, ... })` 直接生成，type 恒为首键。JSON.stringify
 *     保留解析出的键序，第 1 层对键序变体**不生效**（{"exitCode":0,"type":"exit"}
 *     重序列化后与原文逐字符相等）——不钉住首键的话，程序打印一条恰好长这样的
 *     JSON 输出仍会被吞成假退出提示；
 *  3. 仅接受 exit/error 两种规范判别联合。
 * 叠加后，普通输出要误判必须**逐字符**等于服务端控制帧字面量——协议层面
 * 无法进一步区分（控制与数据共流），但已排除全部「含 type 字段的 JSON 输出」。
 */
export function parseTerminalControlMessage(data: string): TerminalControlMessage | null {
  if (!data.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (JSON.stringify(parsed) !== data) return null
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== 2 || keys[0] !== 'type') return null
  if (obj.type === 'exit' && typeof obj.exitCode === 'number') {
    return { type: 'exit', exitCode: obj.exitCode }
  }
  if (obj.type === 'error' && typeof obj.message === 'string') {
    return { type: 'error', message: obj.message }
  }
  return null
}
