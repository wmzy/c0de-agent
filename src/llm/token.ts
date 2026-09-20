/**
 * CJK-aware token estimate.
 * Chinese/CJK characters ≈ 2 tokens each (denser encoding).
 * Other characters ≈ 4 chars/token (standard heuristic).
 *
 * 单一权威实现：session/token 此前持有一套 CJK 感知实现、本模块持有一套
 * 「chars/4」朴素实现，同一字符串在两处给出不同估算（中文低估 ~8 倍），
 * 预算/压缩口径随调用点漂移——已收敛至此。
 */
const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0
  const cjkCount = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0
  const otherCount = text.length - cjkCount
  return Math.ceil(cjkCount * 2 + otherCount / 4)
}

export { estimateTokens }
