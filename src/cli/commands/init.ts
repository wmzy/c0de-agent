// Init command — `c0de init` (design spec §11.3).
//
// Initializes a `.c0de/config.json` file in the current (or specified)
// project directory with default configuration values. Existing config
// files are NOT overwritten unless --force is passed.
//
// Data + functions: no class, no this, no enum.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../core/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitOptions = {
  dir?: string;
  force?: boolean;
};

// ---------------------------------------------------------------------------
// init — create `.c0de/config.json` in the target directory
// ---------------------------------------------------------------------------

export async function init(opts: InitOptions = {}): Promise<void> {
  const projectDir = opts.dir ?? process.cwd();
  const configDir = join(projectDir, ".c0de");
  const configPath = join(configDir, "config.json");

  if (!opts.force && existsSync(configPath)) {
    console.log(`Config already exists at ${configPath}`);
    console.log("Use --force to overwrite.");
    return;
  }

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");

  console.log(`Initialized c0de config at ${configPath}`);
}
