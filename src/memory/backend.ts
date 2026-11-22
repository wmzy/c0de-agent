// Sharpshooter 后端：宿主（chat/print 接线点）消费的唯一门面。
//
// 职责：注入文本装配（三决策文件 + learned.md，共享 injectionTokenLimit 预算，
// per-cwd 缓存、delta 写入/整合应用后失效）、fire-and-forget 提取入口、
// 整合入口（手动 force / 调度到期）、learn 写入。目录布局见 storage.ts；
// 记忆根默认在全局配置目录（resolveGlobalConfigDir），测试/特殊部署经
// opts.memoriesRoot 重定向。

import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { resolveGlobalConfigDir } from '../core/config.js'
import { getLogger } from '../core/logger.js'
import { buildRegistryFromConfig } from '../core/provider-registry.js'
import type { Registry } from '../llm/registry.js'
import type { Config } from '../shared/types/config.js'
import {
  type ConsolidationResult,
  nextConsolidationAt,
  runConsolidation,
  truncateApproxTokens,
} from './consolidate.js'
import {
  buildExtractionEnvelope,
  type MemoryMessage,
  passesExtractionGate,
  runExtraction,
} from './extract.js'
import { appendLearned, readLearned } from './learn.js'
import type { MemoryLlmCall } from './llm-call.js'
import { resolveMemorySettings } from './settings.js'
import { memoryFilePath, projectBankSegment, queueDepth, readState } from './storage.js'
import type { SharpshooterMemoryFile } from './types.js'

const logger = getLogger('memory.backend')

export interface SharpshooterBackend {
  /** 记忆根目录（memories/sharpshooter 的父目录）。 */
  readonly memoriesRoot: string
  /** 注入文本：三决策文件 + learned.md 拼接，截断到 injectionTokenLimit。
   *  全空时返回 null（loop 侧不出现 memory 分片）。 */
  loadContext: (cwd: string) => Promise<string | null>
  /** fire-and-forget 提取入口（chat/print 在用户 prompt 提交后调用）。 */
  startExtractor: (opts: {
    sessionId: string
    cwd: string
    messages: readonly MemoryMessage[]
    current?: MemoryMessage
  }) => void
  /** 等待在途提取（短命进程 print 退出前调用，防 delta 丢失）。 */
  flushExtraction: (timeoutMs?: number) => Promise<void>
  /** 立即整合（force：绕过到期检查，仍受锁/队列约束）。REST/斜杠触发用。 */
  runConsolidationNow: (cwd: string) => Promise<ConsolidationResult>
  /** 单个活跃 cwd 的到期整合（调度 tick 用，非 force）。 */
  consolidateIfDue: (cwd: string) => Promise<ConsolidationResult>
  /** 调度 tick：遍历本进程见过的活跃 cwd 逐个到期整合；错误吞掉不外抛。 */
  schedulerTick: () => Promise<void>
  /** learn 工具的写入通道。 */
  learn: (
    cwd: string,
    memory: string,
    context?: string,
  ) => Promise<{ added: boolean; total: number }>
}

interface ContextCacheEntry {
  text: string | null
  /** delta 写入/整合应用后置脏，下次 loadContext 重算。 */
  dirty: boolean
}

/** 模块级 per-bank 注入缓存（跨 backend 实例共享，见 createSharpshooterBackend
 *  内注释）：同进程内 server 单例与 learn 工具实例共享失效信号。key = bankId。 */
const sharedContextCache = new Map<string, ContextCacheEntry>()

/** 注入头：follow-unless-overridden 指引——记忆是默认约束，用户本轮明示优先。 */
const CONTEXT_HEADER =
  '# Project decision memory (sharpshooter)\n\nFriction-earned project decisions — follow them unless the user explicitly overrides them in the current conversation.'

export function createSharpshooterBackend(
  config: Config,
  opts: {
    /** 活 registry 的获取器（server 传 live registry 以感知配置热更）；
     *  缺省按 config 自建一次（CLI 短命进程足够）。 */
    getRegistry?: () => Registry
    /** 记忆根重定向（测试）。缺省 <全局配置目录>/memories。 */
    memoriesRoot?: string
    /** 依赖注入：提取/整合的 LLM 调用（测试 fake，不真打 provider）。 */
    llmCall?: MemoryLlmCall
  } = {},
): SharpshooterBackend {
  const memoriesRoot = opts.memoriesRoot ?? join(resolveGlobalConfigDir(), 'memories')
  const settings = resolveMemorySettings(config)
  // config 即 MemoryLlmConfig 超集（providers/fallback/memory/default* 都在）。
  const llmConfig = config
  let ownRegistry: Registry | undefined
  const getRegistry = (): Registry => {
    if (opts.getRegistry) return opts.getRegistry()
    // 自建 registry 只建一次：CLI 进程 config 不变，重建无意义。
    ownRegistry ??= buildRegistryFromConfig(config)
    return ownRegistry
  }

  // per-bank 注入缓存：本进程内 delta 追加/整合应用/learn 写入即失效；跨进程
  // 写（CLI 写、server 读）由整合应用路径兜底——server 自己的整合会触发失效
  // 刷新。缓存挂模块级而非实例级：同一进程内 server 单例（注入/提取/整合）与
  // learn 工具的轻量实例共享失效信号，learn 写入后下一次注入不会读到旧记忆。
  const activeCwds = new Set<string>()

  // 缓存 key 带 memoriesRoot 前缀：同 root 的实例（server 单例 + learn 工具
  // 轻量实例，config 相同 → root 相同）共享失效信号；不同 root（测试 tmp
  // 目录、C0DE_CONFIG_DIR 隔离环境）天然不串。
  const cacheKey = (cwd: string): string => `${memoriesRoot}:${projectBankSegment(cwd)}`

  const markDirty = (cwd: string): void => {
    const entry = sharedContextCache.get(cacheKey(cwd))
    if (entry) entry.dirty = true
  }

  const consolidate = async (cwd: string, force: boolean): Promise<ConsolidationResult> => {
    const result = await runConsolidation({
      registry: getRegistry(),
      config: llmConfig,
      memoriesRoot,
      cwd,
      force,
      ...(opts.llmCall ? { llmCall: opts.llmCall } : {}),
      onApplied: () => markDirty(cwd),
    })
    if (result.ran) markDirty(cwd)
    return result
  }

  async function buildContext(cwd: string): Promise<string | null> {
    const files = await Promise.all([
      readMemoryFile(cwd, 'architecture.md'),
      readMemoryFile(cwd, 'product.md'),
      readMemoryFile(cwd, 'style.md'),
      readLearned(memoriesRoot, cwd),
    ])
    const sections: string[] = []
    const push = (title: string, body: string): void => {
      if (body) sections.push(`## ${title}\n\n${body}`)
    }
    push('architecture', files[0])
    push('product', files[1])
    push('style', files[2])
    if (files[3].length > 0) {
      push(
        'learned',
        files[3].map((e) => (e.context ? `${e.memory} (${e.context})` : e.memory)).join('\n'),
      )
    }
    if (sections.length === 0) return null
    return truncateApproxTokens(
      [CONTEXT_HEADER, ...sections].join('\n\n'),
      settings.sharpshooter.injectionTokenLimit,
    )
  }

  async function readMemoryFile(cwd: string, file: SharpshooterMemoryFile): Promise<string> {
    return fs
      .readFile(memoryFilePath(memoriesRoot, cwd, file), 'utf-8')
      .then((text) => text.trim())
      .catch(() => '')
  }

  const consolidateIfDue = async (cwd: string): Promise<ConsolidationResult> => {
    // omp 调度口径：队列空且未到期 → 跳过；否则跑非强制整合（整合内部
    // 还有一层到期检查，这里先挡掉显然无需跑的 tick，省一次锁+读）。
    const [depth, state] = await Promise.all([
      queueDepth(memoriesRoot, cwd),
      Promise.resolve(readState(memoriesRoot, cwd)),
    ])
    const due = Date.now() >= nextConsolidationAt(state, settings.sharpshooter.intervalMinutes)
    if (depth === 0 && !due) return { ran: false, reason: 'not_due' as const }
    return consolidate(cwd, false)
  }

  let inFlight: Promise<void> | undefined

  return {
    memoriesRoot,
    async loadContext(cwd) {
      activeCwds.add(cwd)
      const key = cacheKey(cwd)
      const cached = sharedContextCache.get(key)
      if (cached && !cached.dirty) return cached.text
      const text = await buildContext(cwd)
      sharedContextCache.set(key, { text, dirty: false })
      return text
    },
    startExtractor({ sessionId, cwd, messages, current }) {
      try {
        const envelope = buildExtractionEnvelope(messages, current)
        if (!envelope) return
        if (!passesExtractionGate(envelope.prompt, settings.sharpshooter.minPromptLength)) return
        activeCwds.add(cwd)
        // 串行化在途提取（同会话连发 prompt 时不叠请求）；失败只记日志——
        // 提取是 best-effort 管线，绝不影响主对话路径。
        const run = (inFlight ?? Promise.resolve())
          .then(() =>
            runExtraction({
              registry: getRegistry(),
              config: llmConfig,
              memoriesRoot,
              cwd,
              sessionId,
              envelope,
              ...(opts.llmCall ? { llmCall: opts.llmCall } : {}),
              onDelta: () => markDirty(cwd),
            }),
          )
          .catch((error: unknown) => {
            logger.debug(`sharpshooter extraction failed: ${errorText(error)}`)
          })
          .then(() => {
            if (inFlight === run) inFlight = undefined
          })
        inFlight = run
      } catch (error) {
        logger.debug(`sharpshooter extraction could not start: ${errorText(error)}`)
      }
    },
    async flushExtraction(timeoutMs = 5000) {
      const pending = inFlight
      if (!pending) return
      // 有界等待：settled 后清 timer，避免定时器把短命进程的事件循环挂住。
      // （不用 Promise.withResolvers：当前 tsconfig lib 目标低于 es2024。）
      let releaseBound: () => void
      const bound = new Promise<void>((resolve) => {
        releaseBound = resolve
      })
      const timer = setTimeout(() => releaseBound(), Math.max(0, timeoutMs))
      try {
        await Promise.race([pending, bound])
      } finally {
        clearTimeout(timer)
      }
    },
    runConsolidationNow: (cwd) => consolidate(cwd, true),
    consolidateIfDue,
    async schedulerTick() {
      for (const cwd of activeCwds) {
        try {
          await consolidateIfDue(cwd)
        } catch (error) {
          logger.debug(`scheduler tick failed for ${cwd}: ${errorText(error)}`)
        }
      }
    },
    async learn(cwd, memory, context) {
      const result = await appendLearned(memoriesRoot, cwd, memory, context)
      markDirty(cwd)
      return result
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 调度器：60s tick 调 backend.schedulerTick（活跃 cwd 的到期整合）。
 *  供 server 生命周期接线（server.ts purgeTimer 同款）；返回 stop 函数。 */
export function startScheduler(
  backend: SharpshooterBackend,
  opts: { intervalMs?: number } = {},
): () => void {
  const timer = setInterval(() => void backend.schedulerTick(), opts.intervalMs ?? 60_000)
  timer.unref()
  return () => clearInterval(timer)
}
