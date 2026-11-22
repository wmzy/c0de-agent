// 记忆管线的 LLM 单发调用（提取/整合共用）：chatStream 非流式收集 + toolChoice
// required，逼模型以唯一工具调用产出结构化结果。参照 core/compact.ts 的
// summarizer 形态（registry + fallbackChatOptions），但按工具调用而非纯文本收口。

import { chatStream } from '../llm/provider.js'
import { DEFAULT_MODEL_CAPABILITIES, type Registry, resolveRoute } from '../llm/registry.js'
import { fallbackChatOptions } from '../llm/routing.js'
import type { Config } from '../shared/types/config.js'
import type { ChatRequest, ChatTool, FinishReason, ModelCapabilities } from '../shared/types/llm.js'

/** 管线可见的 Config 子集：模型解析 + 回退链都从这里取。 */
export type MemoryLlmConfig = Pick<
  Config,
  'providers' | 'fallback' | 'memory' | 'defaultProvider' | 'defaultModel'
>

/** 模型选择：memory.sharpshooter.model 覆盖，否则回退 defaultProvider/defaultModel。 */
export function resolveMemoryModel(config: MemoryLlmConfig): { provider: string; model: string } {
  return (
    config.memory?.sharpshooter?.model ?? {
      provider: config.defaultProvider,
      model: config.defaultModel,
    }
  )
}

/** 一次工具调用结果：全部 tool call（含解析后的 arguments）+ 结束原因。 */
export interface MemoryToolCall {
  name: string
  arguments: unknown
}

export interface MemoryToolCallResult {
  toolCalls: MemoryToolCall[]
  finishReason?: FinishReason
}

/** 单发「必须工具调用」的 LLM 请求；流中 error chunk 直接抛（管线无静默降级）。 */
export async function callToolRequired(opts: {
  registry: Registry
  config: MemoryLlmConfig
  system: string
  input: string
  tool: ChatTool
  maxTokens: number
  signal?: AbortSignal
}): Promise<MemoryToolCallResult> {
  const { provider, model } = resolveMemoryModel(opts.config)
  const request: ChatRequest = {
    model,
    system: opts.system,
    messages: [{ role: 'user', content: opts.input }],
    tools: [opts.tool],
    toolChoice: 'required',
    stream: true,
    maxTokens: opts.maxTokens,
  }
  const stream = chatStream({ registry: opts.registry, signal: opts.signal }, request, {
    provider,
    model,
    ...fallbackChatOptions(opts.config, provider, model),
  })
  // tool_call_end 只带 id + 参数串，名字在 tool_call_start——先记名再在 end 配对。
  const names = new Map<string, string>()
  const toolCalls: MemoryToolCall[] = []
  let finishReason: FinishReason | undefined
  for await (const chunk of stream) {
    switch (chunk._tag) {
      case 'tool_call_start':
        names.set(chunk.id, chunk.name)
        break
      case 'tool_call_end': {
        const name = names.get(chunk.id)
        if (!name) break
        let args: unknown
        try {
          args = chunk.argumentsFinal !== undefined ? JSON.parse(chunk.argumentsFinal) : undefined
        } catch {
          args = undefined
        }
        toolCalls.push({ name, arguments: args })
        break
      }
      case 'done':
        finishReason = chunk.finishReason
        break
      case 'error':
        throw new Error(chunk.error.message)
      default:
        break
    }
  }
  return { toolCalls, finishReason }
}

/** 依赖注入用的调用签名（测试传 fake，不真打 provider）。 */
export type MemoryLlmCall = typeof callToolRequired

/** 解析模型能力；路由不可解析（provider 未配置）时回退保守默认。 */
export function resolveModelCaps(
  registry: Registry,
  provider: string,
  model: string,
): ModelCapabilities {
  try {
    return resolveRoute(registry, provider, model).capabilities
  } catch {
    return DEFAULT_MODEL_CAPABILITIES
  }
}

/** 路由是否可解析（provider 已配置）。不可解析 = 管线跳过本趟（no_model）。 */
export function routeAvailable(registry: Registry, provider: string, model: string): boolean {
  try {
    resolveRoute(registry, provider, model)
    return true
  } catch {
    return false
  }
}
