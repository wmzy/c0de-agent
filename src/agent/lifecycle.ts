// Lifecycle event infrastructure (spec §3.3).
//
// Module-level subscriber registry keyed by session id. Keeps lifecycle
// subscribers decoupled from AgentState (no core type changes needed).

import type { AgentState, LifecycleEvent } from "./types";

/** Subscriber callback for lifecycle events. */
export type LifecycleSubscriber = (event: LifecycleEvent) => void;

/** Internal subscriber registry: sessionId → Set of callbacks. */
const lifecycleRegistry = new Map<string, Set<LifecycleSubscriber>>();

/**
 * Subscribe to lifecycle events for a given agent session.
 * Returns an unsubscribe function.
 */
export function subscribeLifecycle(
  state: AgentState,
  subscriber: LifecycleSubscriber,
): () => void {
  const sessionId = state.session.id;
  let subscribers = lifecycleRegistry.get(sessionId);
  if (!subscribers) {
    subscribers = new Set();
    lifecycleRegistry.set(sessionId, subscribers);
  }
  subscribers.add(subscriber);
  return () => {
    subscribers!.delete(subscriber);
    if (subscribers!.size === 0) {
      lifecycleRegistry.delete(sessionId);
    }
  };
}

/**
 * Unsubscribe a specific lifecycle subscriber.
 */
export function unsubscribeLifecycle(
  state: AgentState,
  subscriber: LifecycleSubscriber,
): void {
  const subscribers = lifecycleRegistry.get(state.session.id);
  if (subscribers) {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      lifecycleRegistry.delete(state.session.id);
    }
  }
}

/**
 * Emit a lifecycle event to all subscribers for the given agent state.
 * Subscribers are called synchronously and errors are silently caught
 * so that a misbehaving subscriber never interrupts the agent loop.
 */
export function emitLifecycleEvent(state: AgentState, event: LifecycleEvent): void {
  const subscribers = lifecycleRegistry.get(state.session.id);
  if (!subscribers || subscribers.size === 0) return;
  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch {
      // Subscriber error must never interrupt the agent loop
    }
  }
}

/**
 * Remove all lifecycle subscribers for the given state (cleanup).
 */
export function clearLifecycleSubscribers(state: AgentState): void {
  lifecycleRegistry.delete(state.session.id);
}
