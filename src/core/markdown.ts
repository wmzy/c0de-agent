/**
 * Markdown 代码剥离：围栏代码块与行内代码一律移除，供「只该命中人类文字」的
 * prose 感知检测共用（workflowz 关键词、<todo:*> 标签等）。
 *
 * 此前各检测点自带 ad-hoc 剥离（```...``` 非贪婪配对 + `[^`]*` 单反引号）——
 * 未闭合围栏、~~~ 围栏、长反引号围栏、多反引号行内代码全部漏网：代码内容上的
 * 关键词/标签被误触发（工作流通告注入 / todo 状态幽灵变更）。
 *
 * 语义（保守方向——宁可多剥，不可在代码上误判）：
 * - 围栏开启 = 行首（≤3 空格缩进）+ ≥3 个同字符反引号/波浪线；
 *   闭合 = 同字符、长度 ≥ 开启、行内仅剩空白；未闭合围栏吞掉余文。
 * - 行内代码 = 等长反引号对（``x`` 内可含单反引号，CommonMark 口径）。
 */
export function stripMarkdownCode(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: { char: string; len: number } | null = null

  for (const raw of lines) {
    // CRLF：行尾 \r 不参与围栏判定，也不进入输出
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (!fence) {
      if (m?.[1]) {
        const run = m[1]
        fence = { char: run[0] ?? '`', len: run.length }
      } else {
        out.push(line)
      }
      continue
    }
    // 围栏内：仅「同字符、长度 ≥ 开启、行内无其他字符」的行闭合围栏
    const run = m?.[1]
    if (
      run &&
      run[0] === fence.char &&
      run.length >= fence.len &&
      line.slice(m[0].length).trim() === ''
    ) {
      fence = null
    }
    // 围栏内其余行（含闭合行）一律不输出
  }

  return out.join('\n').replace(/(`+)([\s\S]*?)\1/g, '')
}
