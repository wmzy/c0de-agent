import { Chat } from './Chat.js'

export function ChatView() {
  return (
    <Chat
      messages={[]}
      isStreaming={false}
      usage={null}
      pendingPermission={null}
      onSend={() => {}}
      onAbort={() => {}}
      onConfirm={() => {}}
    />
  )
}
