import { describe, expect, it } from 'vitest'
import { createHealthRoute } from './health.js'

describe('health route', () => {
  it('GET / returns ok status', async () => {
    const app = createHealthRoute()
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; version: string; timestamp: number }
    expect(body.status).toBe('ok')
    expect(body.version).toBeDefined()
  })

  it('GET / includes timestamp', async () => {
    const app = createHealthRoute()
    const res = await app.request('/')
    const body = (await res.json()) as { status: string; version: string; timestamp: number }
    expect(body.timestamp).toBeDefined()
    expect(typeof body.timestamp).toBe('number')
  })
})
