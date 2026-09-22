/**
 * 终端命令块输入跟踪（纯函数）。
 *
 * onTermData 逐字符累积命令文本时，必须正确理解终端输入语义：
 * - DEL(0x7f)/BS(0x08) 删除光标前字符；
 * - 方向键/功能键是转义序列（CSI/SS3/OSC/字符集切换），整体跳过而非把可见
 *   片段（如 ↑ 的 `[A`）当文本累积；
 * - `\r`（Enter）提交当前输入并清空。
 *
 * 此前逐字符逻辑把 0x7f 当可打印字符拼进命令、0x08 被忽略不删字符、
 * 转义序列片段混入——Add to Chat 的命令标签带控制垃圾且编辑后的命令失真。
 * 假设转义序列在同一次调用内完整到达（xterm 按输入事件整序列投递 onData）。
 */

export type TrackedInput = {
  /** 处理后的输入文本（`\r` 清空）。 */
  text: string
  /** 本次 data 中每个 `\r` 提交的命令文本（按出现顺序；无 `\r` 为空数组）。 */
  commands: string[]
}

/** CSI/SS3 序列的终结字节区间（0x40–0x7E）。 */
function isSequenceFinal(ch: string): boolean {
  return ch >= '\x40' && ch <= '\x7e'
}

export function trackCommandInput(current: string, data: string): TrackedInput {
  let buf = current
  const commands: string[] = []
  let i = 0
  while (i < data.length) {
    const ch = data[i] ?? ''
    if (ch === '\r') {
      commands.push(buf)
      buf = ''
      i++
      continue
    }
    if (ch === '\x1b') {
      i++
      const kind = data[i]
      if (kind === '[' || kind === ']') {
        // CSI：ESC [ 参数/中间字节 … 终结字节；OSC：ESC ] … BEL 或 ST(ESC \)。
        i++
        while (i < data.length) {
          const c = data[i] ?? ''
          if (kind === ']' && c === '\x07') {
            i++
            break
          }
          if (kind === ']' && c === '\x1b' && data[i + 1] === '\\') {
            i += 2
            break
          }
          if (kind === '[' && isSequenceFinal(c)) {
            i++
            break
          }
          // OSC 内容可含任意可打印字符：不可终结的字节也继续消费，防内容泄漏进 buf。
          if (kind === ']') {
            i++
            continue
          }
          // 非终结的非 final 字节（参数数字、中间字节）继续消费。
          i++
        }
        continue
      }
      if (kind === 'O' || kind === 'P') {
        // SS3 单字节指令（ESC O X）：连带终结字节一起跳过。
        i = Math.min(i + 2, data.length)
        continue
      }
      // 字符集切换（ESC ( B / ESC ) 0 等，ESC + 2 字节）及其他：跳 ESC 与后随字节。
      i = Math.min(i + 2, data.length)
      continue
    }
    if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1)
      i++
      continue
    }
    if (ch >= ' ' && ch !== '\x7f') {
      buf += ch
      i++
      continue
    }
    // 其余控制字符（Tab、Ctrl-X 等）忽略。
    i++
  }
  return { text: buf, commands }
}
