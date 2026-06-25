// Team mailbox for agent-to-agent communication.
//
// Provides an in-memory message queue that allows agents to send and
// receive messages asynchronously. Messages are stored by recipient
// agent ID and can be drained for injection into the agent loop.
//
// Conventions: data + functions, no class.

// ---------------------------------------------------------------------------
// MailboxMessage — a single message in the team mailbox
// ---------------------------------------------------------------------------

export type MailboxMessage = {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  read: boolean;
};

// ---------------------------------------------------------------------------
// Module-level store: recipient -> messages[]
// ---------------------------------------------------------------------------

const store = new Map<string, MailboxMessage[]>();

// ---------------------------------------------------------------------------
// sendMailbox — send a message to another agent
// ---------------------------------------------------------------------------

export function sendMailbox(from: string, to: string, content: string): Promise<void> {
  const msg: MailboxMessage = {
    id: crypto.randomUUID(),
    from,
    to,
    content,
    timestamp: Date.now(),
    read: false,
  };
  const queue = store.get(to);
  if (queue) {
    queue.push(msg);
  } else {
    store.set(to, [msg]);
  }
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// receiveMailbox — retrieve all pending (unread) messages for a recipient.
//
// Returns a shallow copy of each message so the caller cannot mutate
// the internal store.
// ---------------------------------------------------------------------------

export function receiveMailbox(to: string): Promise<MailboxMessage[]> {
  const msgs = store.get(to) ?? [];
  return Promise.resolve(msgs.filter((m) => !m.read).map((m) => ({ ...m })));
}

// ---------------------------------------------------------------------------
// markAsRead — mark a specific message as read by its id
// ---------------------------------------------------------------------------

export function markAsRead(messageId: string): void {
  for (const msgs of store.values()) {
    for (const msg of msgs) {
      if (msg.id === messageId) {
        msg.read = true;
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// drainMailbox — retrieve and clear all pending messages for a recipient.
//
// Used by the agent loop to drain messages and inject them as steering
// context before an LLM turn.
// ---------------------------------------------------------------------------

export function drainMailbox(recipient: string): MailboxMessage[] {
  const msgs = store.get(recipient);
  if (!msgs || msgs.length === 0) return [];
  store.set(recipient, []);
  return msgs;
}

// ---------------------------------------------------------------------------
// getMailboxSize — lightweight check for pending messages
// ---------------------------------------------------------------------------

export function getMailboxSize(recipient: string): number {
  return store.get(recipient)?.length ?? 0;
}

// ---------------------------------------------------------------------------
// clearMailbox — clear all messages (useful for testing and teardown)
// ---------------------------------------------------------------------------

export function clearMailbox(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// listAllMailbox — snapshot of all pending messages across recipients
// ---------------------------------------------------------------------------

export function listAllMailbox(): MailboxMessage[] {
  const result: MailboxMessage[] = [];
  for (const msgs of store.values()) {
    for (const m of msgs) {
      result.push({ ...m });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// formatMailboxContext — format drained messages into a prompt block
// ---------------------------------------------------------------------------

export function formatMailboxContext(messages: MailboxMessage[]): string {
  if (messages.length === 0) return "";
  const blocks = messages.map(
    (m) =>
      `From: ${m.from}\nSent: ${new Date(m.timestamp).toISOString()}\nMessage:\n${m.content}`,
  );
  return (
    `You have received the following message(s) from your teammates via the team mailbox:\n\n${blocks.join("\n---\n")}\n\n` +
    "Please respond to these messages as appropriate. You can use the sendMailbox tool to reply to your teammates."
  );
}
