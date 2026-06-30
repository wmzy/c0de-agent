const LARGE_PASTE_CHARS = 8000
const LARGE_PASTE_BREAKS = 120

/** 大段粘贴判定：≥8000 字符 或 ≥120 行。 */
function largePaste(text: string): boolean {
  if (text.length >= LARGE_PASTE_CHARS) return true
  let breaks = 0
  for (const char of text) {
    if (char !== '\n') continue
    breaks += 1
    if (breaks >= LARGE_PASTE_BREAKS) return true
  }
  return false
}

/** 规范化换行：CRLF/CR → LF。无 CR 原样返回。 */
function normalizePaste(text: string): string {
  if (!text.includes('\r')) return text
  return text.replace(/\r\n?/g, '\n')
}

/** 粘贴模式：native（原生插入）/ manual（手动处理，可能需确认）。 */
function pasteMode(text: string): 'native' | 'manual' {
  if (largePaste(text)) return 'manual'
  if (text.includes('\n') || text.includes('\r')) return 'manual'
  return 'native'
}

export { LARGE_PASTE_BREAKS, LARGE_PASTE_CHARS, normalizePaste, pasteMode }
