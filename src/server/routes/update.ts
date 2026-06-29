import { Hono } from 'hono'
import { checkForUpdate } from '../../update/index.js'
import type { ServerContext } from '../types.js'

/** GET /api/update — 检查 npm registry 是否有新版本（spec §18.1）。 */
function createUpdateRoute(_ctx: ServerContext): Hono {
  const app = new Hono()

  app.get('/', async (c) => {
    const result = await checkForUpdate()
    return c.json(result)
  })

  return app
}

export { createUpdateRoute }
