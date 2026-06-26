import { describe, it, expect } from 'vitest'
import type { Config, CompactionConfig, MCPServerConfig } from './config.js'

describe('MCPServerConfig', () => {
  it('creates a stdio server config', () => {
    const config: MCPServerConfig = {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
    }
    expect(config.transport).toBe('stdio')
  })

  it('creates an http server config', () => {
    const config: MCPServerConfig = {
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/sse',
    }
    expect(config.transport).toBe('http')
  })
})

describe('CompactionConfig', () => {
  it('creates a compaction config', () => {
    const config: CompactionConfig = {
      enabled: true,
      threshold: 0.8,
      reserveTokens: 4096,
      keepRecentTokens: 8192,
    }
    expect(config.threshold).toBe(0.8)
  })

  it('creates a disabled compaction config', () => {
    const config: CompactionConfig = {
      enabled: false,
      threshold: 0.8,
      reserveTokens: 4096,
      keepRecentTokens: 8192,
    }
    expect(config.enabled).toBe(false)
  })
})

describe('Config', () => {
  it('creates a full config', () => {
    const config: Config = {
      providers: [
        {
          name: 'openai',
          protocol: 'openai',
          apiKey: 'sk-xxx',
        },
      ],
      defaultProvider: 'openai',
      defaultModel: 'gpt-4.1',
      roleRouting: {
        default: { provider: 'openai', model: 'gpt-4.1' },
        smol: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
      fallback: { enabled: true, maxRetries: 3, retryDelay: 1000 },
      compaction: {
        enabled: true,
        threshold: 0.8,
        reserveTokens: 4096,
        keepRecentTokens: 8192,
      },
      tools: { enabled: ['read', 'write', 'bash'], disabled: [] },
      plugins: { enabled: [] },
      mcpServers: [],
      slashCommands: { enabled: ['compact', 'model', 'clear'] },
      theme: 'dark',
      locale: 'zh-CN',
    }
    expect(config.defaultProvider).toBe('openai')
    expect(config.roleRouting.smol?.model).toBe('gpt-4.1-mini')
  })
})
