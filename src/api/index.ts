// API routes

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createProvider } from '../llm'
import { createDefaultRegistry, createExecutor } from '../tools'
import { createAgent } from '../agent'
import { createMemoryStore } from '../session'

const app = new Hono()
app.use('*', cors())

const sessionStore = createMemoryStore()

// Sessions
app.post('/sessions', async (c) => {
  const session = await sessionStore.create()
  return c.json(session)
})

app.get('/sessions', async (c) => {
  const sessions = await sessionStore.list()
  return c.json(sessions)
})

app.get('/sessions/:id', async (c) => {
  const session = await sessionStore.get(c.req.param('id'))
  if (!session) return c.json({ error: 'Session not found' }, 404)
  return c.json(session)
})

app.delete('/sessions/:id', async (c) => {
  await sessionStore.delete(c.req.param('id'))
  return c.json({ ok: true })
})

app.get('/sessions/:id/messages', async (c) => {
  const messages = await sessionStore.getMessages(c.req.param('id'))
  return c.json(messages)
})

// Chat with SSE streaming
app.post('/sessions/:id/chat', async (c) => {
  const sessionId = c.req.param('id')
  const { message } = await c.req.json<{ message: string }>()

  if (!message) {
    return c.json({ error: 'Message is required' }, 400)
  }

  const provider = createProvider({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseUrl: process.env.OPENAI_BASE_URL,
    model: process.env.MODEL_NAME,
  })

  const registry = createDefaultRegistry()
  const executor = createExecutor(registry)

  const agent = createAgent({
    provider,
    tools: registry,
    executor,
    config: {
      workingDirectory: process.env.WORKING_DIRECTORY ?? process.cwd(),
    },
  })

  await sessionStore.addMessage(sessionId, { role: 'user', content: message })

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      try {
        for await (const event of agent.run(message)) {
          if (event.type === 'message') {
            await sessionStore.addMessage(sessionId, {
              role: 'assistant',
              content: event.data as string,
            })
          }

          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (error) {
        const errorEvent = {
          type: 'error',
          data: error instanceof Error ? error.message : String(error),
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})

// Health
app.get('/health', (c) => c.json({ status: 'ok' }))

export default app
