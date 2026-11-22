// oh-my-pi `packages/tui/src/autocomplete.ts` 的 @ 文件补全算法移植（浏览器端适配）。
// 三个能力：
//  1. 子序列紧致度打分——搜索在途时对旧结果即时收窄（oh-my-pi atCompletionMatches
//     的匹配口径在 @shared/utils/string.ts 的 subsequenceMatch，与服务端 /search 的
//     模糊兜底同源）；
//  2. 分层匹配分——basename 精确 > basename 前缀 > 路径包含 > 子序列（oh-my-pi
//     scoreCommandTextMatch 的「精确 1000 > 前缀 900 > 弱匹配」分层口径，扁平前缀分
//     不加长度惩罚，保证同层保持服务端 walk 序）；
//  3. 目录下钻加分——query 以 `/` 结尾（已选定一个目录前缀）时，该目录的直接子项
//     排在深层路径之前（oh-my-pi「前缀结尾 / 即列举该目录内容」的排序对应物）。

/** 子序列紧致度：基础 40 分，每个匹配字符间的跳段 −5，下限 1；不匹配返回 0。 */
export function subsequenceScore(query: string, target: string): number {
  if (query.length === 0) return 1
  if (target === query) return 100
  if (target.startsWith(query)) return 80
  if (target.includes(query)) return 60

  let qi = 0
  let gaps = 0
  let lastMatchIdx = -1
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (query[qi] === target[ti]) {
      if (lastMatchIdx >= 0 && ti - lastMatchIdx > 1) gaps++
      lastMatchIdx = ti
      qi++
    }
  }
  if (qi !== query.length) return 0
  return Math.max(1, 40 - gaps * 5)
}

/** 路径分隔后的最后一段（basename；无分隔符即整段）。 */
function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

/**
 * @ 文件候选的分层匹配分（大小写不敏感）：
 *  - 目录下钻：query 以 `/` 结尾且 path 是该前缀的直接子项 → 950（浮层即目录列举）
 *  - basename 精确相等 → 1000；basename 前缀 → 900（扁平分，无长度惩罚）
 *  - 路径包含 query（服务端子串匹配的既有契约）→ 700
 *  - 路径子序列 → subsequenceScore（1–40；仅出现在旧结果收窄等超集来源里）
 *  无任何命中 → 0。同分项由调用方稳定排序保持来源顺序（服务端 walk 序）。
 */
export function atEntryScore(query: string, path: string): number {
  const lowerQuery = query.toLowerCase()
  const lowerPath = path.toLowerCase()
  const name = basename(lowerPath)

  if (lowerQuery.endsWith('/')) {
    const rest = lowerPath.startsWith(lowerQuery) ? lowerPath.slice(lowerQuery.length) : null
    // 直接子项（余段里没有再深一层的分隔符）优先于深层路径
    if (rest !== null && (rest === '' || !rest.includes('/'))) return 950
  }
  if (lowerQuery.length > 0 && name === lowerQuery) return 1000
  if (lowerQuery.length > 0 && name.startsWith(lowerQuery)) return 900
  if (lowerQuery.length > 0 && lowerPath.includes(lowerQuery)) return 700
  return subsequenceScore(lowerQuery, lowerPath)
}
