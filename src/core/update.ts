// Hot-update support (§18).
//
// Provides version-checking and state-serialization machinery for the hot
// update path. When a newer version of c0de-agent is published, the caller
// can snapshot live agent state, restart the process, and restore.
//
// Conventions: data + functions, no class.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Session } from "../session";
import type { AgentState, Config } from "./types";
import type { Message } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of checking the npm registry for a newer version. */
export type UpdateCheckResult = {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  /** Optional release-notes URL or markdown for the latest version. */
  releaseNotes?: string;
};

/**
 * Serialisable snapshot of live session and agent state, used to transfer
 * across a process restart during hot update.
 */
export type SessionSnapshot = {
  /** The app version that produced this snapshot. */
  version: string;
  /** All active sessions. */
  sessions: Session[];
  /** Agent states (abortController is regenerated on restore). */
  agentStates: (Omit<AgentState, "abortController"> & {
    messages: Message[];
  })[];
  /** The resolved configuration at snapshot time. */
  config: Config;
  /** Unix-epoch ms when the snapshot was taken. */
  timestamp: number;
};

// ---------------------------------------------------------------------------
// Package-version helpers
// ---------------------------------------------------------------------------

let _cachedVersion: string | undefined;

/**
 * Resolve the current package version at runtime.
 *
 * Reads package.json adjacent to `src/core/` — works both in source (tsx/tsc)
 * and after a build (dist/core/update.js → ../../package.json).
 */
async function resolveCurrentVersion(): Promise<string> {
  if (_cachedVersion) return _cachedVersion;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(__dirname, "..", "..", "package.json");

  const raw = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw);
  _cachedVersion = pkg.version as string;
  return _cachedVersion;
}

// ---------------------------------------------------------------------------
// checkForUpdate — query npm registry for the latest published version.
// ---------------------------------------------------------------------------

/**
 * Check whether a newer version of c0de-agent has been published to npm.
 *
 * Fetches `https://registry.npmjs.org/c0de-agent/latest` and compares the
 * published version against the locally installed version.
 *
 * Returns `{ hasUpdate: false }` when the registry is unreachable or the
 * package isn't found (e.g. during development before first publish).
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = await resolveCurrentVersion();

  try {
    const res = await fetch("https://registry.npmjs.org/c0de-agent/latest", {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      // Registry returned an error — not publish-ready yet
      return { hasUpdate: false, currentVersion, latestVersion: currentVersion };
    }

    const data = (await res.json()) as { version: string };
    const latestVersion = data.version;
    const hasUpdate = latestVersion !== currentVersion;

    return {
      hasUpdate,
      currentVersion,
      latestVersion,
      releaseNotes: hasUpdate
        ? `https://github.com/c0de-agent/c0de-agent/releases/tag/v${latestVersion}`
        : undefined,
    };
  } catch {
    // Network error or timeout during development — graceful degradation
    return { hasUpdate: false, currentVersion, latestVersion: currentVersion };
  }
}

// ---------------------------------------------------------------------------
// serializeSessionState — serialise current runtime state into a snapshot.
// ---------------------------------------------------------------------------

/**
 * Serialise live session and agent state into a portable SessionSnapshot.
 *
 * The snapshot strips non-serialisable fields (AbortController) and freezes
 * the remaining data at a point in time so it can be stored or sent to a
 * new process.
 */
export function serializeSessionState(params: {
  sessions: Session[];
  agentStates: AgentState[];
  config: Config;
  version?: string;
}): SessionSnapshot {
  const version = params.version ?? "0.0.0";

  return {
    version,
    sessions: params.sessions,
    agentStates: params.agentStates.map((state) => {
      // Strip abortController — it will be regenerated on restore
      // biome-ignore lint/style/noNonNullAssertion: intentional rest-spread omission
      const { abortController: _, ...rest } = state;
      return rest;
    }),
    config: params.config,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// restoreSessionState — recreate an AgentState from a snapshot.
// ---------------------------------------------------------------------------

/**
 * Restore a single AgentState from a SessionSnapshot.
 *
 * Returns the first entry from `snapshot.agentStates` with a fresh
 * AbortController. The caller is responsible for re-registering tools
 * and re-establishing any runtime context (MCP connections, etc.).
 */
export async function restoreSessionState(snapshot: SessionSnapshot): Promise<AgentState> {
  if (snapshot.agentStates.length === 0) {
    throw new Error("restoreSessionState: snapshot contains no agent states");
  }

  const saved = snapshot.agentStates[0];

  const state: AgentState = {
    ...saved,
    // Fresh controller for the new process
    abortController: new AbortController(),
  };

  return state;
}

// ---------------------------------------------------------------------------
// performHotUpdate — execute the hot-update flow.
// ---------------------------------------------------------------------------

/**
 * Perform a hot update by persisting the session snapshot, signalling the
 * process to restart, and waiting for the new process to restore state.
 *
 * Implementation notes:
 *   1. `serializeSessionState` is called externally — this function receives
 *      the already-built snapshot.
 *   2. The snapshot is written to a well-known temp path so the restarted
 *      process can pick it up.
 *   3. The current process exits with a special code that the process
 *      manager (e.g. PM2, systemd, or a simple restart script) recognises.
 *
 * @param snapshot — the snapshot to persist before restarting.
 */
export async function performHotUpdate(snapshot: SessionSnapshot): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const snapshotPath = join(tmpdir(), `c0de-hot-update-${snapshot.timestamp}.json`);
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

  // Signal the process supervisor to restart
  process.exitCode = 42;

  // In production the process manager reads the temp file and restores state.
  // In development we log the path so a wrapper script can pick it up.
  console.error(`[hot-update] snapshot written to ${snapshotPath}`);
  console.error("[hot-update] process exiting with code 42 for restart");
}
