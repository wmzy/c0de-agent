// Real-time collaboration via WebSocket — data + functions, no class.
//
// A CollaborationSession tracks the set of connected users for a given
// sessionId. Events are broadcast to every participant except the sender.
//
// The module exports a singleton `CollabServer` that owns a `WebSocket.Server`
// and the in-memory session → user → socket map. All state lives in plain
// objects; behaviour is pure functions operating on that state.

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";

// ── Types ───────────────────────────────────────────────────────────────────

/** A single connected user within a collaboration session. */
export type CollabUser = {
  id: string;
  socket: WebSocket;
  joinedAt: number;
};

/** One collaboration session keyed by the Pi session id. */
export type CollaborationSession = {
  sessionId: string;
  users: Map<string, CollabUser>;
  createdAt: number;
  updatedAt: number;
};

/** The shape of an event flowing over the wire. */
export type CollabEvent = {
  type: string;
  payload: unknown;
  senderId?: string;
  timestamp: number;
};

/** The in-memory store: sessionId → CollaborationSession. */
export type CollabStore = Map<string, CollaborationSession>;

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates a new collaboration session record.
 */
export function createCollaborationSession(
  sessionId: string,
): CollaborationSession {
  return {
    sessionId,
    users: new Map(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── Core operations ─────────────────────────────────────────────────────────

/**
 * Adds a user to a session. Creates the session if it does not exist yet.
 */
export function joinSession(
  store: CollabStore,
  sessionId: string,
  userId: string,
  socket: WebSocket,
): CollaborationSession {
  let session = store.get(sessionId);
  if (!session) {
    session = createCollaborationSession(sessionId);
    store.set(sessionId, session);
  }

  // If the user already joined (e.g. reconnected), replace the socket.
  const existing = session.users.get(userId);
  if (existing) {
    existing.socket.close(1000, "replaced by new connection");
  }

  session.users.set(userId, {
    id: userId,
    socket,
    joinedAt: Date.now(),
  });
  session.updatedAt = Date.now();

  // Notify others that this user joined.
  broadcastEvent(store, sessionId, {
    type: "user_joined",
    payload: { userId, users: Array.from(session.users.keys()) },
    senderId: userId,
    timestamp: Date.now(),
  }, userId);

  return session;
}

/**
 * Removes a user from a session. Cleans up the session if it becomes empty.
 */
export function leaveSession(
  store: CollabStore,
  sessionId: string,
  userId: string,
): CollaborationSession | undefined {
  const session = store.get(sessionId);
  if (!session) return undefined;

  const user = session.users.get(userId);
  if (!user) return session;

  user.socket.close(1000, "left");
  session.users.delete(userId);
  session.updatedAt = Date.now();

  if (session.users.size === 0) {
    store.delete(sessionId);
    return undefined;
  }

  broadcastEvent(store, sessionId, {
    type: "user_left",
    payload: { userId, users: Array.from(session.users.keys()) },
    senderId: userId,
    timestamp: Date.now(),
  }, userId);

  return session;
}

/**
 * Broadcasts an event to every connected user in the session except the sender.
 */
export function broadcastEvent(
  store: CollabStore,
  sessionId: string,
  event: CollabEvent,
  excludeUserId?: string,
): void {
  const session = store.get(sessionId);
  if (!session) return;

  const data = JSON.stringify(event);
  session.users.forEach((user, userId) => {
    if (excludeUserId && userId === excludeUserId) return;
    if (user.socket.readyState === WebSocket.OPEN) {
      user.socket.send(data);
    }
  });
}

/**
 * Dispatches an incoming event from a user to all other participants.
 */
export function dispatchEvent(
  store: CollabStore,
  sessionId: string,
  userId: string,
  event: CollabEvent,
): void {
  event.senderId = userId;
  event.timestamp = Date.now();
  broadcastEvent(store, sessionId, event, userId);
}

/**
 * Returns the list of user ids currently in a session.
 */
export function listUsers(
  store: CollabStore,
  sessionId: string,
): string[] {
  const session = store.get(sessionId);
  return session ? Array.from(session.users.keys()) : [];
}

/**
 * Returns the number of users in a session.
 */
export function sessionSize(
  store: CollabStore,
  sessionId: string,
): number {
  const session = store.get(sessionId);
  return session ? session.users.size : 0;
}

// ── WebSocket server wiring ─────────────────────────────────────────────────

/**
 * Configuration for the collab WebSocket server.
 */
export type CollabServerConfig = {
  /** Port to listen on. Defaults to 3001. */
  port?: number;
  /** Optional host to bind to. */
  host?: string;
  /** Callback fired when a user joins. */
  onJoin?: (sessionId: string, userId: string, users: string[]) => void;
  /** Callback fired when a user leaves. */
  onLeave?: (sessionId: string, userId: string, users: string[]) => void;
  /** Callback fired on an arbitrary event. */
  onEvent?: (sessionId: string, userId: string, event: CollabEvent) => void;
};

/**
 * The running collab server instance.
 */
export type CollabServer = {
  store: CollabStore;
  wss: WebSocketServer;
  stop: () => Promise<void>;
};

/**
 * Parses the handshake query string to extract `sessionId` and `userId`.
 * Expected URL: ws://host:port/?sessionId=xxx&userId=yyy
 */
function parseHandshake(req: IncomingMessage): { sessionId: string; userId: string } | null {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");
  const userId = url.searchParams.get("userId");
  if (!sessionId || !userId) return null;
  return { sessionId, userId };
}

/**
 * Creates and starts a WebSocket server for real-time collaboration.
 */
export function createCollabServer(
  config: CollabServerConfig = {},
): CollabServer {
  const { port = 3001, host, onJoin, onLeave, onEvent } = config;
  const store: CollabStore = new Map();

  const wss = new WebSocketServer({ port, host });

  wss.on("connection", (socket, req) => {
    const parsed = parseHandshake(req);
    if (!parsed) {
      socket.close(4000, "missing sessionId or userId");
      return;
    }
    const { sessionId, userId } = parsed;

    const session = joinSession(store, sessionId, userId, socket);
  onJoin?.(sessionId, userId, Array.from(session.users.keys()));

    socket.on("message", (raw) => {
      let event: CollabEvent;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({
          type: "error",
          payload: { message: "invalid JSON" },
          timestamp: Date.now(),
        }));
        return;
      }

      onEvent?.(sessionId, userId, event);
      dispatchEvent(store, sessionId, userId, event);
    });

    socket.on("close", () => {
      leaveSession(store, sessionId, userId);
      const session = store.get(sessionId);
      onLeave?.(sessionId, userId, session ? Array.from(session.users.keys()) : []);
    });
  });

  return {
    store,
    wss,
    stop: async () => {
      return new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
