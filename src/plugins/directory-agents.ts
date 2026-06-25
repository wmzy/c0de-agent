// Directory agents injector (§7.5).
//
// Discovers directory-level agent configurations from a project's
// .c0de/agents/ directory and injects them into the plugin system so that
// each subdirectory acts as a named agent with its own config.
//
// Conventions: data + functions, no class, no enum.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// DirectoryAgent — a directory-scoped agent descriptor
//
// Discovered from .c0de/agents/<name>/ in a project.
// ---------------------------------------------------------------------------

export type DirectoryAgent = {
  name: string;
  path: string;
  config: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// discoverDirectoryAgents — scan .c0de/agents/ for agent directories
//
// Each immediate subdirectory of .c0de/agents/ is a candidate agent.
// A valid agent directory must contain a config file:
//   - agent.json (preferred)
//   - agent.yaml / agent.yml
//   - <name>.json (fallback)
//
// Returns an array of DirectoryAgent sorted by name for deterministic order.
// ---------------------------------------------------------------------------

export async function discoverDirectoryAgents(
  projectDir: string,
): Promise<DirectoryAgent[]> {
  const agentsDir = resolve(projectDir, ".c0de", "agents");
  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
  }>;

  try {
    entries = await readdir(agentsDir, { withFileTypes: true, encoding: "utf8" }) as typeof entries;
  } catch {
    // .c0de/agents/ does not exist — nothing to discover
    return [];
  }

  const results: DirectoryAgent[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const agentDir = join(agentsDir, entry.name);
    const configPath = await resolveAgentConfig(agentDir, entry.name);

    if (!configPath) continue;

    const config = await readAgentConfig(configPath);
    if (!config) continue;

    results.push({
      name: entry.name,
      path: agentDir,
      config,
    });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// ---------------------------------------------------------------------------
// resolveAgentConfig — find a config file inside an agent directory
//
// Priority:
//   1. <dir>/agent.json
//   2. <dir>/agent.yaml
//   3. <dir>/agent.yml
//   4. <dir>/<name>.json
// ---------------------------------------------------------------------------

async function resolveAgentConfig(
  dir: string,
  name: string,
): Promise<string | null> {
  const candidates = [
    join(dir, "agent.json"),
    join(dir, "agent.yaml"),
    join(dir, "agent.yml"),
    join(dir, `${name}.json`),
  ];

  for (const candidate of candidates) {
    try {
      const s = await stat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // File not present — try next candidate
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// readAgentConfig — parse a config file and return a plain object
//
// Supports JSON natively. YAML files are read as text and parsed via
// a simple JSON fallback (YAML is a superset of JSON). For full YAML
// support, integrate a YAML parser; this implementation treats YAML
// files as JSON for now.
// ---------------------------------------------------------------------------

async function readAgentConfig(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    // Parse error or unreadable file — skip this agent
    return null;
  }
}

// ---------------------------------------------------------------------------
// injectDirectoryAgents — merge discovered agents into the plugin registry
//
// For each discovered DirectoryAgent, registers a plugin that exposes the
// agent's config through the PluginContext. The plugin's name is the
// agent's name prefixed with "agent:" to avoid collisions with regular
// plugins.
//
// Returns the list of injected agent names.
// ---------------------------------------------------------------------------

import type { Plugin, PluginRegistry, PluginContext } from "./types";
import { registerPlugin, getPlugin } from "./registry";

export async function injectDirectoryAgents(
  projectDir: string,
  registry: PluginRegistry,
): Promise<string[]> {
  const agents = await discoverDirectoryAgents(projectDir);
  const injected: string[] = [];

  for (const agent of agents) {
    const pluginName = `agent:${agent.name}`;
    const plugin: Plugin = {
      name: pluginName,
      version: "0.0.0",
      setup(_ctx: PluginContext): void {
        // Directory agents are config-only; no runtime setup needed.
        // The config is available via getPlugin(registry, pluginName).
      },
    };

    // Store the agent config on the plugin object for retrieval.
    // The Plugin type doesn't include `config`, so we widen via assertion.
    const pluginWithConfig = plugin as Plugin & { config: Record<string, unknown> };
    pluginWithConfig.config = agent.config;

    registerPlugin(registry, plugin);
    injected.push(agent.name);
  }

  return injected;
}

// ---------------------------------------------------------------------------
// getDirectoryAgent — retrieve a directory agent's config by name
//
// Uses the public getPlugin API; the agent's config is stored as a
// property on the Plugin descriptor.
// ---------------------------------------------------------------------------

export function getDirectoryAgent(
  registry: PluginRegistry,
  name: string,
): { config: Record<string, unknown> } | undefined {
  const plugin = getPlugin(registry, `agent:${name}`);
  if (!plugin) return undefined;
  const config = (plugin as { config?: Record<string, unknown> }).config;
  return config ? { config } : undefined;
}
