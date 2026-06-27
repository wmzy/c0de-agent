import { Hono } from 'hono'

function createHealthRoute(): Hono {
  const app = new Hono()

  app.get('/', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      timestamp: Date.now(),
    })
  })

  return app
}

export { createHealthRoute }
