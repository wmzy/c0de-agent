import { useState, useRef, useEffect } from 'react'
import { css } from '@linaria/core'
import { Button, Textarea, Spinner } from 'haze-ui'
import { useConfig } from '../hooks/useConfig'

const page = css`
  display: flex;
  flex-direction: column;
  height: calc(100vh - 64px);
`

const messagesContainer = css`
  flex: 1;
  overflow-y: auto;
  padding: 24px;
`

const messageBubble = css`
  max-width: 800px;
  margin: 0 auto 16px;
  padding: 16px 20px;
  border-radius: 12px;
  line-height: 1.6;
`

const userBubble = css`
  background: var(--haze-color-primary);
  color: white;
  margin-left: 80px;
`

const assistantBubble = css`
  background: var(--haze-color-bg-subtle);
  margin-right: 80px;
`

const inputArea = css`
  max-width: 800px;
  margin: 0 auto;
  padding: 16px 24px 24px;
  width: 100%;
`

const inputRow = css`
  display: flex;
  gap: 12px;
  align-items: flex-end;
`

const textareaWrapper = css`
  flex: 1;
`

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export default function ChatPage() {
  const { config, logout } = useConfig()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return

    const userMessage = input.trim()
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }])
    setIsLoading(true)

    try {
      const sessionRes = await fetch('/api/sessions', { method: 'POST' })
      const session = await sessionRes.json()

      const response = await fetch(`/api/sessions/${session.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Chat failed')
      }

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      let assistantContent = ''

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

      while (reader) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') break

            try {
              const event = JSON.parse(data)
              if (event.type === 'message') {
                assistantContent += event.data
                setMessages((prev) => {
                  const updated = [...prev]
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    content: assistantContent,
                  }
                  return updated
                })
              } else if (event.type === 'error') {
                throw new Error(event.data)
              }
            } catch (e) {
              if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
                throw e
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Chat error:', error)
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          role: 'assistant',
          content: `错误: ${error instanceof Error ? error.message : '未知错误'}`,
        },
      ])
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className={page}>
      <div className={messagesContainer}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--haze-color-text-muted)', paddingTop: 100 }}>
            <h2 style={{ fontSize: 24, marginBottom: 8 }}>c0de-agent</h2>
            <p>开始对话，让我帮你写代码</p>
            {config && (
              <p style={{ fontSize: 12, marginTop: 16 }}>
                当前模型: {config.model}
                <Button variant="ghost" size="sm" onClick={logout} style={{ marginLeft: 12 }}>
                  切换
                </Button>
              </p>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`${messageBubble} ${msg.role === 'user' ? userBubble : assistantBubble}`}
          >
            {msg.content || (isLoading && i === messages.length - 1 ? <Spinner size="sm" /> : '')}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className={inputArea}>
        <div className={inputRow}>
          <div className={textareaWrapper}>
            <Textarea
              placeholder="输入你的问题..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isLoading}
            />
          </div>
          <Button onClick={sendMessage} disabled={isLoading || !input.trim()}>
            发送
          </Button>
        </div>
      </div>
    </div>
  )
}
