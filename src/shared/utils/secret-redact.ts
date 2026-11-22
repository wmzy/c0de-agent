// 自由文本凭证脱敏（移植自 oh-my-pi 的 memory-backend/redact.ts）。
//
// 与 src/core/redact.ts 的分野：那边是「配置展示脱敏」——按敏感键名（apiKey/
// token/…）掩码配置值，仅服务端使用；这边是「内容脱敏」——不看键名，只看
// 凭证形状，把自由文本中的整段 token 替换为 [REDACTED]。供把用户内容写盘或
// 之后回注提示词的链路使用：一旦凭证被原样存下，后续每次读取都会把它送进
// 每一个 provider，必须在写入前抹除。纯函数、无 node 依赖，web 端可复用。
//
// 导出名说明：omp 原名 redactMemorySecrets（绑定其记忆后端）；c0de 尚无记忆
// 后端，该函数对任意文本生效，故按行为更名为 redactSecretText。

// 固定前缀 provider token（AWS / GitHub / npm / Slack / Google）。每条都锚定
// 字面量前缀，replace 单遍扫过即可，无回溯风险。
const PATTERNS = [
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /npm_[A-Za-z0-9]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
]

// 关键字必须按长度降序：`token_` 要先于 `tok` 命中，替换起点才能落在完整关键字
// 的开头（若 `sk` 抢先，`task_` 之类会被从中间抹起）。
const KEYWORDS = ['password', 'secret', 'token', 'key', 'tok', 'sk', 'pk', 'rk']

// 字母数字混合的分段 ≥12 即视为凭证形状；非混合段（纯字母或纯数字）要求 ≥16。
// 这样既保住 `password-supersecretvalue`、`token-abcdefghijklmnop`，又不误伤
// `authentication`、`configuration` 这类日常长单词。
const MIN_MIXED_SEGMENT = 12
const MIN_LETTERS_SEGMENT = 16

/** 分隔符仅 `-`(45) 与 `_`(95)：凭证串最常见的分段边界。 */
const isDelimiter = (code: number) => code === 45 || code === 95

function isCredentialSegment(length: number, letter: boolean, digit: boolean): boolean {
  if (!letter && !digit) return false
  if (letter && digit) return length >= MIN_MIXED_SEGMENT
  return length >= MIN_LETTERS_SEGMENT
}

/** token 字符：字母、数字、`-`、`_`。其余一切字符（点、斜杠、中文、空白）都是段界。 */
const isTokenChar = (code: number) =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  isDelimiter(code)

/** 分隔符左侧若恰好是某个关键字，返回该关键字的起点，否则 -1。 */
function keywordStart(input: string, delimiter: number): number {
  for (const keyword of KEYWORDS) {
    const start = delimiter - keyword.length
    if (start >= 0 && input.startsWith(keyword, start)) return start
  }
  return -1
}

/**
 * 抹除「关键字 + 分隔符 + 凭证形状段」结构，如 `secret_aB3dEfGh1JkLmN`。
 *
 * 正则表达不了「本段之后的某段混合了字母数字」而不回看尾部——`token_aaaa-`
 * 重复两万次是一个不间断区间，逐候选回看尾部就是二次方复杂度，而本函数会被
 * 同步地跑在整段转写文本上。因此每个区间只走一遍：先切分段并记录形状，再
 * 倒序扫出后缀标记（「第 k 段及之后是否存在凭证段」），之后每个分隔符的
 * 判定都是 O(1)。
 */
function redactKeywordSecrets(input: string): string {
  let out = ''
  let copied = 0
  let index = 0
  while (index < input.length) {
    if (!isTokenChar(input.charCodeAt(index))) {
      index++
      continue
    }

    const runStart = index
    const starts: number[] = [runStart]
    const credential: boolean[] = []
    let length = 0
    let letter = false
    let digit = false
    while (index < input.length && isTokenChar(input.charCodeAt(index))) {
      const current = input.charCodeAt(index)
      if (isDelimiter(current)) {
        credential.push(isCredentialSegment(length, letter, digit))
        starts.push(index + 1)
        length = 0
        letter = false
        digit = false
      } else {
        length++
        if (current >= 48 && current <= 57) digit = true
        else letter = true
      }
      index++
    }
    credential.push(isCredentialSegment(length, letter, digit))
    const runEnd = index

    // suffix[k] =「第 k 段及之后是否存在凭证形状段」，倒序一遍扫出。
    const suffix: boolean[] = Array.from({ length: credential.length + 1 }, () => false)
    for (let k = credential.length - 1; k >= 0; k--)
      suffix[k] = suffix[k + 1] === true || credential[k] === true

    for (const [k, segmentStart] of starts.entries()) {
      if (k === 0 || !suffix[k]) continue
      const start = keywordStart(input, segmentStart - 1)
      // start < copied / start < runStart 理论上不可达（关键字字符即 token 字符，
      // 关键字不可能伸出区间之外），保留为防御性不变量。
      if (start < 0 || start < copied || start < runStart) continue
      // 凭证常被切成多段（sk_live_…），一旦命中就从关键字起点抹到整个区间末尾。
      out += `${input.slice(copied, start)}[REDACTED]`
      copied = runEnd
      break
    }
  }
  return copied === 0 ? input : out + input.slice(copied)
}

const MIN_JWT_SEGMENT = 16

/**
 * 抹除 `header.payload.signature` 形态的 JWT。
 *
 * 被它取代的正则形态（`[A-Za-z0-9_-]{16,}\.` 叠两次）在「长标识符、几乎没有
 * 点」的转写文本上会从每个起点重扫尾部。点很稀疏，锚定每个点向两侧丈量，
 * 每个字符只被常数次访问。
 */
function redactJwts(input: string): string {
  let out = ''
  let copied = 0
  let dot = input.indexOf('.')
  while (dot > 0) {
    let start = dot
    while (start > copied && isTokenChar(input.charCodeAt(start - 1))) start--
    let middle = dot + 1
    while (middle < input.length && isTokenChar(input.charCodeAt(middle))) middle++
    let end = middle + 1
    while (end < input.length && isTokenChar(input.charCodeAt(end))) end++
    const looksLikeJwt =
      dot - start >= MIN_JWT_SEGMENT &&
      input.charCodeAt(middle) === 46 && // 46 = '.'，中段之后必须是第二个点
      middle - dot - 1 >= MIN_JWT_SEGMENT &&
      end - middle - 1 >= MIN_JWT_SEGMENT
    if (looksLikeJwt) {
      out += `${input.slice(copied, start)}[REDACTED]`
      copied = end
      dot = input.indexOf('.', end)
      continue
    }
    dot = input.indexOf('.', dot + 1)
  }
  return copied === 0 ? input : out + input.slice(copied)
}

/** 对自由文本做三层凭证脱敏：关键字凭证段 → JWT 三段 → 固定前缀 token。
 *  命中一律整段替换为 [REDACTED]；三层都是手写单遍扫描或字面量锚定，总复杂度
 *  与文本长度线性相关。 */
export function redactSecretText(input: string): string {
  // 关键字层先跑：它产出的 `[REDACTED]` 含非 token 字符，天然截断区间，后续
  // 两层不会跨越标记匹配，三层互不干扰。
  let out = redactJwts(redactKeywordSecrets(input))
  for (const pattern of PATTERNS) out = out.replace(pattern, '[REDACTED]')
  return out
}
