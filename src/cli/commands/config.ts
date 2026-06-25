// Config command — `c0de config get|set` (design spec §11.3).
//
//   c0de config get [key]           — view the full config or a specific key
//   c0de config set <key> <value>   — set a config key to a JSON value
//
// Operates on the project-level config (.c0de/config.json) by default.
// Pass --global to target ~/.c0de/config.json instead.
//
// Data + functions: no class, no this, no enum.

import { loadConfig, saveConfig } from "../../core/config";
import type { ConfigScope } from "../../core/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConfigCommandOptions = {
  scope?: ConfigScope;
  projectDir?: string;
};

// ---------------------------------------------------------------------------
// configGet — print the full config or a single key to stdout
// ---------------------------------------------------------------------------

export async function configGet(
  key: string | undefined,
  opts: ConfigCommandOptions = {},
): Promise<void> {
  const projectDir = opts.projectDir ?? process.cwd();
  const config = await loadConfig(projectDir);

  if (key === undefined) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  // Navigate dotted key path (e.g. "compaction.threshold")
  const parts = key.split(".");
  let value: unknown = config as Record<string, unknown>;
  for (const part of parts) {
    if (value === null || value === undefined || typeof value !== "object") {
      console.error(`Key not found: ${key}`);
      process.exit(1);
    }
    value = (value as Record<string, unknown>)[part];
  }

  console.log(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// configSet — set a config key and persist
// ---------------------------------------------------------------------------

export async function configSet(
  key: string,
  value: string,
  opts: ConfigCommandOptions = {},
): Promise<void> {
  const projectDir = opts.projectDir ?? process.cwd();
  const config = await loadConfig(projectDir);

  // Parse the value as JSON if possible, otherwise treat as string
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }

  // Navigate dotted key path, creating intermediate objects as needed
  const parts = key.split(".");
  const targetKey = parts.pop()!;
  let current: Record<string, unknown> = config as Record<string, unknown>;

  for (const part of parts) {
    if (!(part in current) || current[part] === null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  current[targetKey] = parsed;

  await saveConfig(config, opts.scope ?? "project", { projectDir: opts.projectDir });

  console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
}
