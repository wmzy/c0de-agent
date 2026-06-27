import { describe, expect, it } from 'vitest'
import type { DBConfig, DBDriver } from './types.js'

describe('DBConfig', () => {
  it('creates a pglite config with dataDir', () => {
    const config: DBConfig = { driver: 'pglite', dataDir: '/home/user/.c0de/data' }
    expect(config.driver).toBe('pglite')
  })

  it('creates a pglite config without dataDir (in-memory)', () => {
    const config: DBConfig = { driver: 'pglite' }
    expect(config.driver).toBe('pglite')
  })

  it('creates a postgres config', () => {
    const config: DBConfig = {
      driver: 'postgres',
      connectionString: 'postgresql://user:pass@localhost:5432/c0de',
    }
    expect(config.driver).toBe('postgres')
  })
})

describe('DBDriver', () => {
  it('accepts all driver values', () => {
    const drivers: DBDriver[] = ['pglite', 'postgres']
    expect(drivers).toHaveLength(2)
  })
})
