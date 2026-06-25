// Configuration loading and merging (per design spec §3.5).
//
// Three-layer merge (later overrides earlier):
//   1. Built-in defaults
//   2. Global config ~/.c0de/config.json
//   3. Project config <projectDir>/.c0de/config.json
//
// Persistence uses Node fs/promises; resolution of $HOME falls back to
// process.env.HOME and process.env.USERPROFILE.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runHooks } from "../plugins/hooks";
import type { PluginRegistry } from "../plugins/types";
import type { AgentConfig, CompactionConfig, Config, MCPServerConfig } from "./types";

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

export const DEFAULT_COMPACTION: CompactionConfig = {
  enabled: true,
  threshold: 0.8,
  reserveTokens: 2000,
  keepRecentTokens: 4000,
};

export const DEFAULT_CONFIG: Config = {
  providers: [],
  defaultProvider: "openai",
  defaultModel: "gpt-4o",
  roleRouting: {},
  fallback: { enabled: true, maxRetries: 3, retryDelay: 1000 },
  compaction: DEFAULT_COMPACTION,
  tools: { enabled: [], disabled: [] },
  plugins: { enabled: [] },
  mcpServers: [],
  slashCommands: { enabled: ["compact", "model", "clear", "help", "fork", "config"] },
  theme: "system",
  locale: "en-US",
};

// ---------------------------------------------------------------------------
// Filesystem locations
// ---------------------------------------------------------------------------

export type ConfigScope = "global" | "project";

export function globalConfigPath(): string {
  const home = homedir();
  return join(home, ".c0de", "config.json");
}

export function projectConfigPath(projectDir: string): string {
  return join(projectDir, ".c0de", "config.json");
}

// ---------------------------------------------------------------------------
// mergeConfig — partial merges, each later one overrides earlier values
// for object-typed fields (shallow merge per top-level key).
// ---------------------------------------------------------------------------

export function mergeConfig(...configs: Array<Partial<Config> | undefined | null>): Config {
  let acc: Partial<Config> = {};
  for (const partial of configs) {
    if (!partial) continue;
    acc = mergePartial(acc, partial);
  }
  // Final pass: fill any missing field from DEFAULT_CONFIG so the result is
  // always a complete Config (callers can rely on every field being set).
  return fillDefaults(acc);
}

function mergePartial(a: Partial<Config>, b: Partial<Config>): Partial<Config> {
  const out: Partial<Config> = { ...a };
  for (const key of Object.keys(b) as Array<keyof Config>) {
    const next = b[key];
    const prev = a[key];
    if (prev === undefined || next === undefined) {
      (out as Record<string, unknown>)[key] = next;
      continue;
    }
    // Special-case object-typed fields so callers can patch nested slices
    // (e.g. mergeConfig({compaction:{threshold:0.7}})) without wiping peers.
    if (isPlainObject(prev) && isPlainObject(next)) {
      (out as Record<string, unknown>)[key] = { ...prev, ...next };
      continue;
    }
    if (Array.isArray(prev) && Array.isArray(next)) {
      // Arrays: later array fully replaces (no concat) to match expected
      // "override" semantics — enabling a different plugin list should not
      // silently inherit disabled entries from a previous layer.
      (out as Record<string, unknown>)[key] = [...next];
      continue;
    }
    (out as Record<string, unknown>)[key] = next;
  }
  return out;
}

function fillDefaults(partial: Partial<Config>): Config {
  const merged = mergePartial(DEFAULT_CONFIG, partial);
  // mergePartial above already returned Partial<Config>; assert completeness.
  return merged as Config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// ---------------------------------------------------------------------------
// loadConfig / saveConfig
// ---------------------------------------------------------------------------

export async function loadConfig(
  projectDir?: string,
  pluginRegistry?: PluginRegistry,
): Promise<Config> {
  const layers: Array<Partial<Config> | undefined> = [];

  layers.push(await readConfigFile(globalConfigPath()));

  if (projectDir !== undefined) {
    layers.push(await readConfigFile(projectConfigPath(projectDir)));
  }

  let config = mergeConfig(...layers);

  // Hook: config:resolve — let plugins modify merged config before use.
  if (pluginRegistry) {
    try {
      const hooked = await runHooks(pluginRegistry, "config:resolve", { config });
      config = hooked.config;
    } catch {
      // Hook failure must not interrupt config loading
    }
  }

  return config;
}

export async function saveConfig(
  config: Config,
  scope: ConfigScope,
  opts: { projectDir?: string } = {},
): Promise<void> {
  const target =
    scope === "global" ? globalConfigPath() : projectConfigPath(opts.projectDir ?? process.cwd());
  await mkdir(dirOf(target), { recursive: true });
  await writeFile(target, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// AgentConfig helper — derive a single agent run config from the merged
// Config (selects provider+model via role routing or defaults).
// ---------------------------------------------------------------------------

export function resolveAgentConfig(base: Config, override: Partial<AgentConfig> = {}): AgentConfig {
  const provider = override.provider ?? base.defaultProvider;
  const model = override.model ?? base.defaultModel;
  return {
    provider,
    model,
    maxTokens: override.maxTokens,
    temperature: override.temperature,
    systemPrompt: override.systemPrompt,
    tools: override.tools ?? deriveEnabledTools(base),
    plugins: override.plugins ?? deriveEnabledPlugins(base),
  };
}

export function deriveEnabledTools(config: Config): string[] {
  const disabled = new Set(config.tools.disabled);
  return config.tools.enabled.filter((name) => !disabled.has(name));
}

export function deriveEnabledPlugins(config: Config): string[] {
  return [...config.plugins.enabled];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readConfigFile(path: string): Promise<Partial<Config> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error(`Invalid config file ${path}: expected JSON object at top level`);
    }
    return parsed as Partial<Config>;
  } catch (err) {
    throw new Error(`Failed to parse config file ${path}: ${(err as Error).message}`);
  }
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

// Avoid unused-import lint complaint when MCPServerConfig isn't directly
// referenced after a future refactor.
export type { MCPServerConfig };
