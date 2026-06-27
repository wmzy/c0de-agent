import { describe, expect, it } from 'vitest'
import { parseCommand } from './parser.js'
import type { CommandSpec } from './parser.js'

const spec: CommandSpec = {
  name: 'chat',
  description: 'chat',
  options: [
    { name: 'model', type: 'string' },
    { name: 'yes', type: 'boolean', short: 'y' },
  ],
}

describe('parseCommand', () => {
  it('parses string option', () => {
    const args = parseCommand(spec, ['--model', 'gpt-4o', 'hello'])
    expect(args.options.model).toBe('gpt-4o')
    expect(args.positionals).toEqual(['hello'])
  })

  it('parses = form', () => {
    const args = parseCommand(spec, ['--model=gpt-5', 'hi'])
    expect(args.options.model).toBe('gpt-5')
  })

  it('parses boolean with short flag', () => {
    const args = parseCommand(spec, ['-y', 'hi'])
    expect(args.options.yes).toBe(true)
  })

  it('defaults boolean to false when absent', () => {
    const args = parseCommand(spec, ['hi'])
    expect(args.options.yes).toBe(false)
  })

  it('collects multiple positionals', () => {
    const args = parseCommand(spec, ['one', 'two'])
    expect(args.positionals).toEqual(['one', 'two'])
  })

  it('throws on unknown option', () => {
    expect(() => parseCommand(spec, ['--bogus', 'x'])).toThrow()
  })
})
