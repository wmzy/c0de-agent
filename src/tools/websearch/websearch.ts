import type { WebSearchConfig } from '../../shared/types/config.js'
import type { ToolDef, ToolResult } from '../../shared/types/tool.js'
import { formatForLLM, runWebSearch, setFetchOverride } from './index.js'

export { setFetchOverride }

const NO_RESULTS = 'No search results found. Try a different query.'

/**
 * websearch 工具工厂。config 由工厂闭包捕获（对齐 runSubAgent/debugSpawn 依赖反转模式）。
 * permission: auto（只读网络搜索，不改本地状态）。timeout 30s。
 * 详见 docs/superpowers/specs/2026-06-30-websearch-tool-design.md §5。
 */
export function createWebSearchTool(config: WebSearchConfig): ToolDef {
  return {
    name: 'websearch',
    description:
      'Search the web for up-to-date information beyond knowledge cutoff. ' +
      'Returns titled sources with snippets (and a synthesized answer when the ' +
      'backend supports it). Use for current events, recent releases, and docs. ' +
      `The current year is ${new Date().getFullYear()}.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        numResults: {
          type: 'number',
          description: 'Number of results (default 8, max 20)',
        },
        recency: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Time filter for results',
        },
      },
      required: ['query'],
    },
    permission: 'auto',
    timeout: 30_000,
    execute: async (input, ctx): Promise<ToolResult> => {
      const { query, numResults, recency } = input as {
        query: string
        numResults?: number
        recency?: 'day' | 'week' | 'month' | 'year'
      }
      try {
        const response = await runWebSearch({ query, numResults, recency }, config, ctx.abort)
        if (!response.answer && response.sources.length === 0) {
          return { _tag: 'success', output: NO_RESULTS }
        }
        return { _tag: 'success', output: formatForLLM(response) }
      } catch (err) {
        return { _tag: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
