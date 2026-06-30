/**
 * websearch 工具类型与常量测试。
 *
 * 来源：oh-my-pi（packages/coding-agent/src/web/search/）多后端 strategy 架构，
 * 裁剪适配 c0de-agent 的 data+functions 范式。
 * 归并建议：本测试与 types.ts 同属 websearch 子包，无既有 skill-tests/integration 适用，故就地建文件。
 */
import { describe, expect, it } from 'vitest'
import { clampNumResults, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS, MIN_NUM_RESULTS } from './types.js'

describe('websearch types', () => {
  it('exposes default/min/max result constants', () => {
    expect(DEFAULT_NUM_RESULTS).toBe(8)
    expect(MIN_NUM_RESULTS).toBe(1)
    expect(MAX_NUM_RESULTS).toBe(20)
  })

  it('clampNumResults returns default for undefined', () => {
    expect(clampNumResults(undefined)).toBe(DEFAULT_NUM_RESULTS)
  })

  it('clampNumResults clamps below min', () => {
    expect(clampNumResults(0)).toBe(MIN_NUM_RESULTS)
    expect(clampNumResults(-1)).toBe(MIN_NUM_RESULTS)
  })

  it('clampNumResults clamps above max', () => {
    expect(clampNumResults(21)).toBe(MAX_NUM_RESULTS)
    expect(clampNumResults(1000)).toBe(MAX_NUM_RESULTS)
  })

  it('clampNumResults passes through in-range values', () => {
    expect(clampNumResults(5)).toBe(5)
    expect(clampNumResults(MIN_NUM_RESULTS)).toBe(MIN_NUM_RESULTS)
    expect(clampNumResults(MAX_NUM_RESULTS)).toBe(MAX_NUM_RESULTS)
  })

  it('clampNumResults honors custom fallback', () => {
    expect(clampNumResults(undefined, 3)).toBe(3)
  })

  it('clampNumResults truncates fractional values', () => {
    expect(clampNumResults(5.9)).toBe(5)
    expect(clampNumResults(NaN)).toBe(DEFAULT_NUM_RESULTS)
  })
})
