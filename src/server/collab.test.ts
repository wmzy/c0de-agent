// Unit tests for src/server/collab.ts
// Run: npx tsx src/server/collab.test.ts

import { WebSocket } from "ws";
import {
  createCollaborationSession,
  joinSession,
  leaveSession,
  broadcastEvent,
  dispatchEvent,
  listUsers,
  sessionSize,
  createCollabServer,
} from "./collab";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

// ── createCollaborationSession ──────────────────────────────────────────────

{
  const s = createCollaborationSession("sess-1");
  assert(s.sessionId === "sess-1", "sessionId");
  assert(s.users.size === 0, "empty users");
  assert(s.createdAt > 0, "createdAt");
}

// ── joinSession ─────────────────────────────────────────────────────────────

{
  const store = new Map();
  const makeMockSocket = () => ({
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
  }) as unknown as WebSocket;

  // Join first user creates the session
  const s1 = joinSession(store, "sess-a", "u1", makeMockSocket());
  assert(store.has("sess-a"), "session created");
  assert(s1.users.size === 1, "1 user after first join");

  // Join second user
  const s2 = joinSession(store, "sess-a", "u2", makeMockSocket());
  assert(s2.users.size === 2, "2 users after second join");

  // Different session
  joinSession(store, "sess-b", "u3", makeMockSocket());
  assert(store.has("sess-b"), "second session created");
  assert(store.get("sess-b")!.users.size === 1, "sess-b has 1 user");
}

// ── leaveSession ────────────────────────────────────────────────────────────

{
  const store = new Map();
  const closed: string[] = [];
  const makeMockSocket = (id: string) => ({
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => closed.push(id),
  }) as unknown as WebSocket;

  joinSession(store, "sess-c", "u1", makeMockSocket("u1"));
  joinSession(store, "sess-c", "u2", makeMockSocket("u2"));

  // Leave one user
  const afterLeave = leaveSession(store, "sess-c", "u1");
  assert(afterLeave!.users.size === 1, "1 user after leave");
  assert(afterLeave!.users.has("u2"), "u2 still in session");
  assert(closed.includes("u1"), "u1 socket closed");

  // Leave last user removes session
  const empty = leaveSession(store, "sess-c", "u2");
  assert(empty === undefined, "session removed when empty");
  assert(!store.has("sess-c"), "session deleted from store");

  // Leave from non-existent session
  assert(leaveSession(store, "nonexistent", "u1") === undefined, "leave non-existent returns undefined");
}

// ── listUsers / sessionSize ─────────────────────────────────────────────────

{
  const store = new Map();
  const makeMockSocket = () => ({
    readyState: WebSocket.OPEN,
    send: () => {},
    close: () => {},
  }) as unknown as WebSocket;

  joinSession(store, "sess-d", "u1", makeMockSocket());
  joinSession(store, "sess-d", "u2", makeMockSocket());
  joinSession(store, "sess-d", "u3", makeMockSocket());

  const users = listUsers(store, "sess-d");
  assert(users.length === 3, "listUsers count");
  assert(users.includes("u1"), "listUsers includes u1");

  assert(sessionSize(store, "sess-d") === 3, "sessionSize");
  assert(sessionSize(store, "nonexistent") === 0, "sessionSize non-existent");
}

// ── broadcastEvent (real sockets) ───────────────────────────────────────────

{
  const store = new Map();
  const sent: string[] = [];

  // Mock socket that captures sends
  const makeMockSocket = (id: string) => ({
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(`${id}:${data}`),
    close: () => {},
  }) as unknown as WebSocket;

  // Suppress join-broadcast noise by using a clean store
  joinSession(store, "sess-e", "u1", makeMockSocket("u1"));
  joinSession(store, "sess-e", "u2", makeMockSocket("u2"));
  joinSession(store, "sess-e", "u3", makeMockSocket("u3"));

  // Clear join-event noise
  const baseline = sent.length;

  broadcastEvent(store, "sess-e", {
    type: "cursor",
    payload: { x: 10, y: 20 },
    senderId: "u1",
    timestamp: Date.now(),
  }, "u1");

  const newSent = sent.slice(baseline);
  // u1 should NOT receive its own event; u2 and u3 should
  assert(newSent.length === 2, `broadcast sends to 2 recipients (got ${newSent.length})`);
  assert(newSent.every(s => !s.startsWith("u1:")), "sender excluded");
  assert(newSent.some(s => s.startsWith("u2:")), "u2 received");
  assert(newSent.some(s => s.startsWith("u3:")), "u3 received");
}

// ── dispatchEvent ───────────────────────────────────────────────────────────

{
  const store = new Map();
  const sent: string[] = [];

  const makeMockSocket = (id: string) => ({
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
    close: () => {},
  }) as unknown as WebSocket;

  joinSession(store, "sess-f", "u1", makeMockSocket("u1"));
  joinSession(store, "sess-f", "u2", makeMockSocket("u2"));

  // Clear join-event noise
  const baseline = sent.length;

  dispatchEvent(store, "sess-f", "u1", {
    type: "edit",
    payload: { text: "hello" },
    timestamp: 0,
  });

  const newSent = sent.slice(baseline);
  assert(newSent.length === 1, `dispatch sends to 1 other user (got ${newSent.length})`);
  const evt = JSON.parse(newSent[0]!);
  assert(evt.senderId === "u1", "senderId set");
  assert(evt.timestamp > 0, "timestamp updated");
}

// ── createCollabServer (integration) ────────────────────────────────────────

{
  const joinEvents: string[] = [];
  const leaveEvents: string[] = [];

  const s2 = createCollabServer({
    port: 3100,
    onJoin: (sid, uid) => joinEvents.push(`${sid}:${uid}`),
    onLeave: (sid, uid) => leaveEvents.push(`${sid}:${uid}`),
  });

  const ws1 = new WebSocket("ws://localhost:3100/?sessionId=test&userId=a");
  const ws2 = new WebSocket("ws://localhost:3100/?sessionId=test&userId=b");

  ws1.on("open", () => {
    ws2.on("open", () => {
      // Both joined
      setTimeout(() => {
        assert(joinEvents.length === 2, "2 join events");
        assert(joinEvents.includes("test:a"), "join event for a");
        assert(joinEvents.includes("test:b"), "join event for b");

        // a sends an event, b should receive it
        ws1.send(JSON.stringify({ type: "ping", payload: {} }));

        ws2.on("message", (data) => {
          const evt = JSON.parse(data.toString());
          assert(evt.type === "ping", "received ping event");
          assert(evt.senderId === "a", "sender is a");

          // Close both
          ws1.close();
          ws2.close();

          setTimeout(() => {
            assert(leaveEvents.length === 2, "2 leave events");
            s2.stop().then(() => {
              console.log(`\n${passed} passed, ${failed} failed`);
              process.exit(failed > 0 ? 1 : 0);
            });
          }, 200);
        });
      }, 100);
    });
  });
}
