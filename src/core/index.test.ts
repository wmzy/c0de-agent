import { describe, expect, it } from 'vitest'
import * as core from './index.js'

describe('core barrel export', () => {
  it('exports config functions', () => {
    expect(typeof core.DEFAULT_CONFIG).toBe('object')
    expect(typeof core.loadConfig).toBe('function')
    expect(typeof core.mergeConfig).toBe('function')
    expect(typeof core.saveConfig).toBe('function')
  })

  it('exports context functions', () => {
    expect(typeof core.createTokenBudget).toBe('function')
    expect(typeof core.fitToBudget).toBe('function')
    expect(typeof core.shouldCompact).toBe('function')
    expect(typeof core.calibrateEstimate).toBe('function')
  })

  it('exports prompt builder', () => {
    expect(typeof core.buildSystemPrompt).toBe('function')
  })

  it('exports steering functions', () => {
    expect(typeof core.injectSteering).toBe('function')
    expect(typeof core.drainSteering).toBe('function')
  })

  it('exports agent functions', () => {
    expect(typeof core.createAgent).toBe('function')
    expect(typeof core.runAgent).toBe('function')
    expect(typeof core.pauseAgent).toBe('function')
    expect(typeof core.resumeAgent).toBe('function')
    expect(typeof core.abortAgent).toBe('function')
  })

  it('exports slash command registry', () => {
    expect(typeof core.createSlashRegistry).toBe('function')
    expect(typeof core.parseSlashInput).toBe('function')
  })

  it('exports compaction bridge', () => {
    expect(typeof core.createSummarizer).toBe('function')
    expect(typeof core.runCompaction).toBe('function')
  })
})
