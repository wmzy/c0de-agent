/**
 * 交互辅助（oh-my-pi composer-prediction / idle-recap 口径迁移）的纯逻辑：
 * 上下文裁剪、prompt 构建与模型回复清洗。端点接线在 server/routes/session.ts
 * （预测=POST /:id/predict-prompt，回顾=GET /:id/recap），模型调用走
 * createSummarizerWithFallback（compaction 同款 side-turn 通道）。
 */
import type { Message } from '../shared/types/message.js'

/** 预测/回顾带入模型的最近消息条数（对话走向由尾部决定；控制计费输入量）。 */
const RECENT_MESSAGE_COUNT = 8
/** 单条消息文本截断（字符）：只保留走向，长输出（工具结果/大段代码）无预测价值。 */
const PER_MESSAGE_CHARS = 600
/** 预测回复没有把握时模型被要求回复的原文。 */
export const PREDICTION_SKIP_REPLY = 'NO_PREDICTION'
/** 更长的预测回复是模型在自说自话而非用户会打的话；丢弃（omp 同值）。 */
const MAX_PREDICTION_LENGTH = 500
/** 预测/回顾 side-turn 的输出上限与截止时间。 */
export const ASSIST_MAX_TOKENS = 256
export const ASSIST_DEADLINE_MS = 15_000
/** 模型偶尔给整段回复包一层引号/反引号；剥掉再看内容。 */
const WRAPPING_QUOTES = /^(?:"([^"]*)"|“([^“”]*)”|`([^`]*)`)$/

/** 消息纯文本（text/steering part；工具调用与 thinking 对预测/回顾无价值）。 */
function messageText(message: Message): string {
  return message.content
    .filter((p) => p._tag === 'text' || p._tag === 'steering')
    .map((p) => (p as { text: string }).text)
    .join(' ')
    .trim()
}

/** 最近 N 条 user/assistant 消息的「role: 文本」对话视图（截断到走向级）。 */
export function recentTranscript(messages: readonly Message[]): string {
  const recent = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-RECENT_MESSAGE_COUNT)
    .map((m) => {
      const text = messageText(m).slice(0, PER_MESSAGE_CHARS)
      return text ? `${m.role === 'user' ? '用户' : '助手'}: ${text}` : null
    })
    .filter((line): line is string => line !== null)
  return recent.join('\n')
}

/** 预测 prompt：预测用户下一条消息（omp composer-prediction-user.md 的中文适配，
 *  单候选形态）。 */
export function buildPredictionPrompt(transcript: string): string {
  return [
    '预测这段对话中用户的下一条消息。只回复那条消息本身，完全按用户会打出来的样子。',
    '- 用用户的口吻：他们的语言、语气与惯用长度，只从用户自己发的消息判断。',
    '- 跟进最新的助手回复：批准、转向、询问下一步，或汇报一个结果。',
    '- 一行，简短（通常 20 字以内）；不要引号、编号、前缀或 markdown。',
    '- 没有把握时只回复 NO_PREDICTION。',
    '',
    '对话：',
    transcript,
  ].join('\n')
}

/** 回顾 prompt：用户离开后回来的现状一行（omp recap-user.md 的中文适配）。 */
export function buildRecapPrompt(transcript: string): string {
  return [
    '用户离开了一会儿，现在回来了。用与对话一致的语言写一行回顾：40 字以内、1-2 句纯文本、无 markdown。',
    '先讲总体目标与当前进行到哪，再给一个下一步动作。跳过根因分析、实现细节与次要待办。',
    '',
    '对话：',
    transcript,
  ].join('\n')
}

/** 预测回复清洗：NO_PREDICTION/空白/超长/剥包裹引号；不可用返回 null。 */
export function sanitizePrediction(reply: string | undefined | null): string | null {
  const trimmed = (reply ?? '').trim()
  if (!trimmed || trimmed === PREDICTION_SKIP_REPLY) return null
  const unwrapped = WRAPPING_QUOTES.exec(trimmed)
  const text = (unwrapped?.[1] ?? unwrapped?.[2] ?? unwrapped?.[3] ?? trimmed).trim()
  if (!text || text === PREDICTION_SKIP_REPLY) return null
  if (text.length > MAX_PREDICTION_LENGTH) return null
  return text
}

/** 回顾回复清洗：空白即无（浮层不显示）；截断到一行。 */
export function sanitizeRecap(reply: string | undefined | null): string | null {
  const text = (reply ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return null
  return text.length > 200 ? text.slice(0, 200) : text
}

export { RECENT_MESSAGE_COUNT }
