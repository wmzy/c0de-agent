import { css } from '@linaria/core'
import { useState, useRef, useEffect } from 'react'
import { ConfigPanel } from './components/ConfigPanel'

const appClass = css`
  display: flex;
  flex-direction: column;
  height: 100dvh;
  font-family: system-ui, sans-serif;
  color: #e6edf3;
  background: #0d1117;
`

const headerClass = css`
  padding: 16px;
  border-bottom: 1px solid #30363d;
  display: flex;
  justify-content: space-between;
  align-items: center;
`

const titleClass = css`
  font-weight: bold;
`

const configInfoClass = css`
  font-size: 12px;
  color: #8b949e;
`

const logoutButtonClass = css`
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #30363d;
  background: transparent;
  color: #8b949e;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background: #21262d;
    color: #e6edf3;
  }
`

const messagesClass = css`
  flex: 1;
  overflow-y: auto;
  padding: 16px;
`

const messageClass = css`
  margin-bottom: 16px;
  padding: 12px;
  border-radius: 8px;
`

const userMessageClass = css`
  background: #1f6feb33;
  border: 1px solid #1f6feb;
`

const assistantMessageClass = css`
  background: #21262d;
  border: 1px solid #30363d;
`

const inputAreaClass = css`
  display: flex;
  gap: 8px;
  padding: 16px;
  border-top: 1px solid #30363d;
`

const inputClass = css`
  flex: 1;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  font-size: 14px;
  resize: none;

  &:focus {
    outline: none;
    border-color: #1f6feb;
  }
`

const buttonClass = css`
  padding: 12px 24px;
  border-radius: 8px;
  border: none;
  background: #238636;
  color: white;
  font-weight: bold;
  cursor: pointer;

  &:hover {
    background: #2ea043;
  }

  &:disabled {
    background: #21262d;
    cursor: not-allowed;
  }
`

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Config {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
}

export function App() {
  const [config, setConfig] = useState<Config | null>(() => {
    const saved = localStorage.getItem('c0de-config')
    return saved ? JSON.parse(saved) : null
  })
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleConfigConfirm = async (newConfig: Config) => {
    // Send config to server
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newConfig),
    })

    localStorage.setItem('c0de-config', JSON.stringify(newConfig))
    setConfig(newConfig)
  }

  const handleLogout = () => {
    localStorage.removeItem('c0de-config')
    setConfig(null)
    setMessages([])
  }

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
              }
            } catch {
              // Skip invalid JSON
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
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

  // Show config panel if not configured
  if (!config) {
    return (
      <div className={appClass}>
        <div className={headerClass}>
          <span className={titleClass}>c0de-agent</span>
        </div>
        <ConfigPanel onConfirm={handleConfigConfirm} />
      </div>
    )
  }

  return (
    <div className={appClass}>
      <div className={headerClass}>
        <span className={titleClass}>c0de-agent</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className={configInfoClass}>
            {config.provider} / {config.model}
          </span>
          <button className={logoutButtonClass} onClick={handleLogout}>
            切换 Provider
          </button>
        </div>
      </div>

      <div className={messagesClass}>
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`${messageClass} ${
              msg.role === 'user' ? userMessageClass : assistantMessageClass
            }`}
          >
            <strong>{msg.role === 'user' ? 'You' : 'Assistant'}:</strong>
            <div style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>
              {msg.content || (isLoading && i === messages.length - 1 ? '...' : '')}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className={inputAreaClass}>
        <textarea
          className={inputClass}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message..."
          rows={1}
          disabled={isLoading}
        />
        <button
          className={buttonClass}
          onClick={sendMessage}
          disabled={isLoading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}
