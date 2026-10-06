/**
 * ModelSelector 组件测试，对应 src/web/components/ModelSelector.tsx。
 * model 建议项来自 config.providers[当前provider].models（enabled 省略/true 视为启用），
 * 组件为可搜索下拉：点击 ▾ 打开时展示全部启用模型（可逃逸过滤），
 * 键入即按子串过滤；允许输入列表外的自定义模型名；点击/键盘选中后回填。
 */

import type { Config } from '@shared/types/config.js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ModelSelection, ModelSelector } from '@/components/ModelSelector.js'
import { useConfig } from '@/contexts/ConfigContext.js'
import { providerAPI } from '@/services/provider.js'

const baseConfig: Config = {
  providers: [
    {
      name: 'sensenova',
      protocol: 'openai-compat',
      apiKey: 'sk-xxx',
      baseURL: 'https://api.sensenova.cn/compatible-mode/v1',
      models: {
        'SenseChat-5': {},
        'SenseChat-Vision': { enabled: true },
        'SenseChat-Reasoning': { enabled: false },
      },
    },
    {
      name: 'openai',
      protocol: 'openai',
      apiKey: 'sk-oai',
      baseURL: 'https://api.openai.com/v1',
      models: { 'gpt-4o': {} },
    },
  ],
  defaultProvider: 'sensenova',
  defaultModel: 'SenseChat-5',
  roleRouting: {},
  fallback: { enabled: false, maxRetries: 2, retryDelay: 1000 },
  compaction: { enabled: true, threshold: 0.8, reserveTokens: 1000, keepRecentTokens: 500 },
  tools: { enabled: ['*'], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: ['*'] },
  toolMetrics: { enabled: true, threshold: 0.8, minSamples: 5 },
  security: { authEnabled: false, allowedOrigins: [] },
  websearch: { provider: 'auto' },
  agents: { subagentConcurrency: 3 },
  permission: { defaultMode: 'default' },
  update: { enabled: false, intervalMs: 3_600_000, initialDelayMs: 10_000 },
  usage: { monthlyBudgetUsd: 0 },
  theme: 'light',
}

vi.mock('@/services/provider.js', () => ({
  providerAPI: { list: vi.fn() },
}))

vi.mock('@/contexts/ConfigContext.js', () => ({
  useConfig: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** 有状态挂载：真实复刻父组件受控用法（onChange 回写 state），
 * 使"选中回填/键入回显"等往返行为可被断言。 */
function Harness({
  initial,
  onChange,
}: {
  initial: ModelSelection
  onChange: (v: ModelSelection) => void
}) {
  const [sel, setSel] = useState(initial)
  return (
    <ModelSelector
      value={sel}
      onChange={(v) => {
        setSel(v)
        onChange(v)
      }}
    />
  )
}

function renderSelector(value: ModelSelection, config: Config = baseConfig) {
  const onChange = vi.fn()
  vi.mocked(useConfig).mockReturnValue({
    config,
    loading: false,
    refresh: vi.fn(),
    warnings: [],
    scopes: { global: null, project: null },
  })
  vi.mocked(providerAPI.list).mockResolvedValue({
    providers: config.providers.map((p) => ({
      name: p.name,
      protocol: p.protocol,
      baseURL: p.baseURL ?? '',
      hasKey: !!p.apiKey,
    })),
    defaultProvider: config.defaultProvider,
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <Harness initial={value} onChange={onChange} />
    </QueryClientProvider>,
  )
  return { ...view, onChange }
}

/** 打开 model 下拉并返回列表项文本。 */
function hints() {
  const btn = document.querySelector('[data-testid="model-dropdown"]')
  if (btn) fireEvent.click(btn)
  const list = document.querySelector('[data-testid="model-hints"]')
  if (!list) return []
  return Array.from(list.querySelectorAll('button')).map((b) => b.textContent || '')
}

function modelInput() {
  const el = document.querySelector('[data-testid="model-input"]')
  if (!el) throw new Error('model-input 不存在')
  return el as HTMLInputElement
}

describe('ModelSelector — model 建议项', () => {
  it('仅展示当前 provider 启用的模型（enabled 省略/true 视为启用）', () => {
    renderSelector({ provider: 'sensenova', model: '' })
    // 3 个模型里 SenseChat-Reasoning 被 enabled:false 过滤掉
    expect(hints()).toEqual(['SenseChat-5', 'SenseChat-Vision'])
  })

  it('切换 provider 后建议项跟随该 provider 的模型', () => {
    renderSelector({ provider: 'openai', model: '' })
    expect(hints()).toEqual(['gpt-4o'])
  })

  it('当前 provider 无 models 时不渲染下拉', () => {
    const cfg: Config = {
      ...baseConfig,
      providers: [{ name: 'plain', protocol: 'openai-compat', apiKey: 'k', baseURL: '' }],
    }
    renderSelector({ provider: 'plain', model: '' }, cfg)
    expect(document.querySelector('[data-testid="model-dropdown"]')).toBeNull()
  })

  // 回归：原生 <datalist> 在 input 有值时会按该值过滤选项。自定义列表
  // 点开时始终展示全部启用模型（可逃逸过滤），过滤仅由键入触发。
  it('点击 ▾ 打开时展示全部启用模型，不受 input 当前值影响', () => {
    renderSelector({ provider: 'sensenova', model: 'SenseChat-5' })
    expect(hints()).toEqual(['SenseChat-5', 'SenseChat-Vision'])
  })
})

describe('ModelSelector — 可搜索下拉', () => {
  it('键入即按子串过滤（忽略大小写），空列表显示无匹配提示', () => {
    const { onChange } = renderSelector({ provider: 'sensenova', model: '' })
    const input = modelInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'vision' } })
    expect(input.value).toBe('vision')
    expect(
      Array.from(document.querySelectorAll('[data-testid="model-hints"] button')).map(
        (b) => b.textContent,
      ),
    ).toEqual(['SenseChat-Vision'])
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'sensenova', model: 'vision' })

    // 过滤无匹配：显示空态提示，不清空输入值
    fireEvent.change(input, { target: { value: 'nope-model' } })
    const list = document.querySelector('[data-testid="model-hints"]')
    expect(list?.querySelectorAll('button').length).toBe(0)
    expect(list?.querySelector('[data-testid="model-hints-empty"]')?.textContent).toContain(
      '无匹配模型',
    )
    expect(input.value).toBe('nope-model')
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'sensenova', model: 'nope-model' })
  })

  it('允许手输列表外的自定义模型名并回传', () => {
    const { onChange } = renderSelector({ provider: 'sensenova', model: '' })
    fireEvent.change(modelInput(), { target: { value: 'my-custom-model' } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'sensenova', model: 'my-custom-model' })
    expect(modelInput().value).toBe('my-custom-model')
  })

  it('点击列表项选中并回填输入框，列表收起', () => {
    const { onChange } = renderSelector({ provider: 'sensenova', model: '' })
    const dropdown = document.querySelector('[data-testid="model-dropdown"]')
    expect(dropdown).not.toBeNull()
    fireEvent.click(dropdown as HTMLElement)
    const items = document.querySelectorAll('[data-testid="model-hints"] button')
    const secondItem = items[1]
    expect(secondItem).toBeDefined()
    fireEvent.click(secondItem as HTMLElement)
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'sensenova', model: 'SenseChat-Vision' })
    expect(modelInput().value).toBe('SenseChat-Vision')
    expect(document.querySelector('[data-testid="model-hints"]')).toBeNull()
  })

  it('↑↓ 移动高亮，Enter 选中回填，Escape 收起', () => {
    const { onChange } = renderSelector({ provider: 'sensenova', model: '' })
    const input = modelInput()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'sensenova', model: 'SenseChat-Vision' })
    expect(input.value).toBe('SenseChat-Vision')

    // 重新打开后 Escape 收起，且不触发选择
    onChange.mockClear()
    const dropdown = document.querySelector('[data-testid="model-dropdown"]')
    expect(dropdown).not.toBeNull()
    fireEvent.click(dropdown as HTMLElement)
    expect(document.querySelector('[data-testid="model-hints"]')).not.toBeNull()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(document.querySelector('[data-testid="model-hints"]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  // 复现：输入框的 ↑↓/Enter/Escape 处理不看 IME 组合态。中文/日文输入法用回车
  // 确认候选词（keydown 携带 isComposing=true）时，未拦截会把候选当最终输入：
  // 回车直接确认高亮模型并回填输入框，方向键还会在候选未确认时移动高亮项。
  it('IME 组合中的回车/方向键不选模型（中文输入法确认候选）', () => {
    const { onChange } = renderSelector({ provider: 'sensenova', model: '' })
    const input = modelInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Sense' } })
    onChange.mockClear()

    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

    // 未回填选中模型、未上抛变更，输入框仍是用户正在组合的内容
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('Sense')
  })
})

// 回归：▾ 按钮只调 openHints，焦点留在按钮上，而 ↑↓/Enter/Escape 只挂在
// combobox 的 onKeyDown 上——键盘点开列表后这几个键全部落空，列表对键盘不可用。
describe('ModelSelector — ▾ 按钮打开的列表', () => {
  it('点开后焦点进入输入框，↑↓+Enter 可选中', () => {
    const { onChange } = renderSelector({ provider: 'sensenova', model: '' })
    const input = modelInput()
    const dropdown = document.querySelector('[data-testid="model-dropdown"]') as HTMLElement
    dropdown.focus()

    fireEvent.click(dropdown)

    expect(document.querySelector('[data-testid="model-hints"]')).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenLastCalledWith({ provider: 'sensenova', model: 'SenseChat-Vision' })
    expect(input.value).toBe('SenseChat-Vision')
    expect(document.querySelector('[data-testid="model-hints"]')).toBeNull()
  })

  it('点开后 Escape 收起列表且不误选模型', () => {
    const { onChange } = renderSelector({ provider: 'sensenova', model: '' })
    const input = modelInput()
    const dropdown = document.querySelector('[data-testid="model-dropdown"]') as HTMLElement

    fireEvent.click(dropdown)
    expect(document.querySelector('[data-testid="model-hints"]')).not.toBeNull()

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(document.querySelector('[data-testid="model-hints"]')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    // 焦点回到输入框，可继续键入过滤
    expect(document.activeElement).toBe(input)
  })

  it('点开后不因焦点转入输入框而立即被 onFocus 重新弹出后又被跳过', () => {
    renderSelector({ provider: 'sensenova', model: '' })
    const dropdown = document.querySelector('[data-testid="model-dropdown"]') as HTMLElement

    fireEvent.click(dropdown)
    // 焦点转入输入框触发的 onFocus 必须被跳过，否则列表会被 skipOpenRef
    // 的复位时序打乱：要么刚打开就收起，要么下一次聚焦打不开。
    expect(document.querySelector('[data-testid="model-hints"]')).not.toBeNull()

    // 标志已在微任务里复位：离开再聚焦输入框应照常自动展开
    fireEvent.blur(document.activeElement as HTMLElement)
    fireEvent.focus(modelInput())
    expect(document.querySelector('[data-testid="model-hints"]')).not.toBeNull()
  })
})
