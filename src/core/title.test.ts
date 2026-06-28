import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DB } from '../db/client.js'
import { createDB } from '../db/client.js'
import { migrateDB } from '../db/migrate.js'
import type { Registry } from '../llm/registry.js'
import { createSession, getSession } from '../session/session.js'
import type { ChatRequest } from '../shared/types/llm.js'
import type { Config } from './config.js'
import { DEFAULT_SESSION_TITLE, generateSessionTitle, isDefaultTitle } from './title.js'

/** 可注入的 fake chat：返回预设文本并记录收到的 provider/model。 */
function fakeChat(text: string, captured: { provider?: string; model?: string } = {}) {
  return async (
    _ctx: unknown,
    _request: ChatRequest,
    options: { provider: string; model: string },
  ): Promise<string> => {
    captured.provider = options.provider
    captured.model = options.model
    return text
  }
}

/** 抛错的 fake chat，用于验证错误被吞掉。 */
function throwingChat(error: unknown = new Error('boom')) {
  return async (): Promise<string> => {
    throw error
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    providers: [],
    defaultProvider: 'openai',
    defaultModel: 'gpt-4o',
    roleRouting: {},
    fallback: { enabled: false, maxRetries: 0, retryDelay: 0 },
    compaction: { enabled: false, threshold: 0.8, reserveTokens: 8000, keepRecentTokens: 4000 },
    tools: { enabled: [], disabled: [] },
    plugins: { enabled: [] },
    mcpServers: [],
    slashCommands: { enabled: [] },
    theme: 'system',
    locale: 'en',
    ...overrides,
  } as Config
}

let db: DB

beforeEach(async () => {
  db = await createDB({ driver: 'pglite' })
  await migrateDB(db)
})

afterEach(async () => {
  await db.close()
})

describe('isDefaultTitle', () => {
  it('matches the default placeholder', () => {
    expect(isDefaultTitle(DEFAULT_SESSION_TITLE)).toBe(true)
    expect(isDefaultTitle('New Session')).toBe(true)
  })

  it('rejects any other title', () => {
    expect(isDefaultTitle('Refactoring auth')).toBe(false)
    expect(isDefaultTitle('')).toBe(false)
  })
})

describe('generateSessionTitle', () => {
  it('persists a cleaned title from the first user message', async () => {
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    await generateSessionTitle(
      { db, llmRegistry: {} as Registry, config: makeConfig(), chatFn: fakeChat('Fix login bug') },
      session.id,
      'Help me fix the login 500 error',
      'openai',
      'gpt-4o',
    )
    const updated = await getSession(db, session.id)
    expect(updated?.title).toBe('Fix login bug')
    expect(updated?.title).not.toBe(DEFAULT_SESSION_TITLE)
  })

  it('strips <think> tags from reasoning-model output', async () => {
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    await generateSessionTitle(
      {
        db,
        llmRegistry: {} as Registry,
        config: makeConfig(),
        chatFn: fakeChat('<think>pondering</think>\nAuth refresh token support'),
      },
      session.id,
      'add refresh token to auth',
      'openai',
      'gpt-4o',
    )
    const updated = await getSession(db, session.id)
    expect(updated?.title).toBe('Auth refresh token support')
  })

  it('takes the first non-empty trimmed line', async () => {
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    await generateSessionTitle(
      {
        db,
        llmRegistry: {} as Registry,
        config: makeConfig(),
        chatFn: fakeChat('  \n\n  Rate limiting\n  \nimplementation  '),
      },
      session.id,
      'implement rate limiting',
      'openai',
      'gpt-4o',
    )
    const updated = await getSession(db, session.id)
    expect(updated?.title).toBe('Rate limiting')
  })

  it('truncates titles exceeding 100 characters with an ellipsis', async () => {
    const longTitle = 'A'.repeat(150)
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    await generateSessionTitle(
      { db, llmRegistry: {} as Registry, config: makeConfig(), chatFn: fakeChat(longTitle) },
      session.id,
      'some long task',
      'openai',
      'gpt-4o',
    )
    const updated = await getSession(db, session.id)
    expect(updated?.title.length).toBe(100)
    expect(updated?.title.endsWith('...')).toBe(true)
    expect(updated?.title.startsWith('AAAA')).toBe(true)
  })

  it('leaves the title untouched when the model returns empty', async () => {
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    await generateSessionTitle(
      { db, llmRegistry: {} as Registry, config: makeConfig(), chatFn: fakeChat('   ') },
      session.id,
      'hello',
      'openai',
      'gpt-4o',
    )
    const updated = await getSession(db, session.id)
    expect(updated?.title).toBe(DEFAULT_SESSION_TITLE)
  })

  it('leaves the title untouched when output is only whitespace/newlines', async () => {
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    await generateSessionTitle(
      { db, llmRegistry: {} as Registry, config: makeConfig(), chatFn: fakeChat('\n\t  \n') },
      session.id,
      'hi',
      'openai',
      'gpt-4o',
    )
    const updated = await getSession(db, session.id)
    expect(updated?.title).toBe(DEFAULT_SESSION_TITLE)
  })

  it('never throws and never overwrites when chat fails', async () => {
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    await expect(
      generateSessionTitle(
        { db, llmRegistry: {} as Registry, config: makeConfig(), chatFn: throwingChat() },
        session.id,
        'anything',
        'openai',
        'gpt-4o',
      ),
    ).resolves.toBeUndefined()
    const updated = await getSession(db, session.id)
    expect(updated?.title).toBe(DEFAULT_SESSION_TITLE)
  })

  it('prefers the smol role when configured', async () => {
    const captured: { provider?: string; model?: string } = {}
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    const config = makeConfig({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      roleRouting: { smol: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
    await generateSessionTitle(
      { db, llmRegistry: {} as Registry, config, chatFn: fakeChat('Smol title', captured) },
      session.id,
      'task',
      'openai',
      'gpt-4o',
    )
    expect(captured.provider).toBe('deepseek')
    expect(captured.model).toBe('deepseek-chat')
  })

  it('falls back to the chat provider/model when smol is not configured', async () => {
    const captured: { provider?: string; model?: string } = {}
    const session = await createSession(db, DEFAULT_SESSION_TITLE)
    const config = makeConfig({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      roleRouting: {},
    })
    await generateSessionTitle(
      { db, llmRegistry: {} as Registry, config, chatFn: fakeChat('Chat model title', captured) },
      session.id,
      'task',
      'deepseek',
      'deepseek-chat',
    )
    expect(captured.provider).toBe('deepseek')
    expect(captured.model).toBe('deepseek-chat')
  })
})
