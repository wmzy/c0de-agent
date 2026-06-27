import { describe, it, expect } from 'vitest'
import type { ToolDef } from '../shared/types/tool.js'
import {
  createToolRegistry,
  registerTool,
  registerToolFactory,
  getTool,
  listTools,
  getToolSchemas,
} from './registry.js'

function makeTool(name: string): ToolDef {
  return {
    name,
    description: `Tool ${name}`,
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
    permission: 'auto',
    execute: async () => ({ _tag: 'success', output: 'ok' }),
  }
}

describe('tool registry', () => {
  it('creates an empty registry', () => {
    const reg = createToolRegistry()
    expect(listTools(reg)).toEqual([])
    expect(getTool(reg, 'x')).toBeUndefined()
  })

  it('registers and retrieves a tool', () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('read'))
    expect(getTool(reg, 'read')?.name).toBe('read')
    expect(listTools(reg).map((t) => t.name)).toEqual(['read'])
  })

  it('overwrites a tool with the same name', () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('read'))
    const v2 = makeTool('read')
    v2.description = 'updated'
    registerTool(reg, v2)
    expect(getTool(reg, 'read')?.description).toBe('updated')
    expect(listTools(reg).length).toBe(1)
  })

  it('registers a lazy factory', () => {
    const reg = createToolRegistry()
    let factoryCalled = false
    registerToolFactory(reg, 'lazy', (ctx) => {
      factoryCalled = true
      return makeTool('lazy')
    })
    // Factory not called until getTool
    expect(factoryCalled).toBe(false)
    const tool = getTool(reg, 'lazy', { config: {}, cwd: '/tmp' })
    expect(factoryCalled).toBe(true)
    expect(tool?.name).toBe('lazy')
  })

  it('factory returning null registers nothing', () => {
    const reg = createToolRegistry()
    registerToolFactory(reg, 'noop', () => null)
    expect(getTool(reg, 'noop', { config: {}, cwd: '/tmp' })).toBeUndefined()
  })

  it('caches factory result after first getTool call', () => {
    const reg = createToolRegistry()
    let callCount = 0
    registerToolFactory(reg, 'cached', () => {
      callCount++
      return makeTool('cached')
    })
    getTool(reg, 'cached', { config: {}, cwd: '/tmp' })
    getTool(reg, 'cached', { config: {}, cwd: '/tmp' })
    expect(callCount).toBe(1)
  })

  it('listTools triggers all factories', () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('eager1'))
    registerToolFactory(reg, 'lazy1', () => makeTool('lazy1'))
    registerToolFactory(reg, 'lazy2', () => null) // unavailable

    const tools = listTools(reg, { config: {}, cwd: '/tmp' })
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['eager1', 'lazy1'])
  })

  it('getToolSchemas returns ChatTool array', () => {
    const reg = createToolRegistry()
    registerTool(reg, makeTool('read'))
    registerTool(reg, makeTool('write'))
    const schemas = getToolSchemas(reg)
    expect(schemas.length).toBe(2)
    expect(schemas[0]).toHaveProperty('name')
    expect(schemas[0]).toHaveProperty('description')
    expect(schemas[0]).toHaveProperty('parameters')
  })
})
