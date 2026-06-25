// Plugin command — `c0de plugin list|install` (design spec §11.3).
//
//   c0de plugin list            — list installed plugins
//   c0de plugin install <name>  — install a plugin via npm
//
// Plugins are discovered from:
//   1. Project-local:  <projectDir>/.c0de/plugins/
//   2. Global:         ~/.c0de/plugins/
//
// Data + functions: no class, no this, no enum.

import { execFile } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PluginInfo = {
  name: string;
  version?: string;
  source: "project" | "global" | "npm";
  path: string;
};

// ---------------------------------------------------------------------------
// pluginList — list installed plugins from project-local and global dirs
// ---------------------------------------------------------------------------

export async function pluginList(projectDir: string): Promise<PluginInfo[]> {
  const plugins: PluginInfo[] = [];

  // 1. Project-local .c0de/plugins/
  const projectPluginDir = join(projectDir, ".c0de", "plugins");
  plugins.push(...(await discoverFromDirectory(projectPluginDir, "project")));

  // 2. Global ~/.c0de/plugins/
  const globalPluginDir = join(homedir(), ".c0de", "plugins");
  plugins.push(...(await discoverFromDirectory(globalPluginDir, "global")));

  // 3. npm packages matching c0de-plugin-* in node_modules
  plugins.push(...(await discoverFromNpm(projectDir)));

  return plugins;
}

// ---------------------------------------------------------------------------
// discoverFromDirectory — scan a directory for plugin subdirectories
// ---------------------------------------------------------------------------

async function discoverFromDirectory(
  dir: string,
  source: PluginInfo["source"],
): Promise<PluginInfo[]> {
  const results: PluginInfo[] = [];

  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      const entryStat = await stat(entryPath);
      if (!entryStat.isDirectory()) continue;

      const pluginPath = join(entryPath, "package.json");
      let version: string | undefined;
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(pluginPath, "utf8");
        const pkg = JSON.parse(raw);
        version = pkg.version;
      } catch {
        // No package.json — still a valid plugin directory
      }

      results.push({ name: entry, version, source, path: entryPath });
    }
  } catch {
    // Directory doesn't exist or is unreadable — that's fine
  }

  return results;
}

// ---------------------------------------------------------------------------
// discoverFromNpm — discover c0de-plugin-* packages in node_modules
// ---------------------------------------------------------------------------

async function discoverFromNpm(projectDir: string): Promise<PluginInfo[]> {
  const results: PluginInfo[] = [];
  const nodeModules = join(projectDir, "node_modules");

  try {
    const entries = await readdir(nodeModules);
    for (const entry of entries) {
      if (!entry.startsWith("c0de-plugin-")) continue;

      const entryPath = join(nodeModules, entry);
      const entryStat = await stat(entryPath);
      if (!entryStat.isDirectory()) continue;

      let version: string | undefined;
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(join(entryPath, "package.json"), "utf8");
        const pkg = JSON.parse(raw);
        version = pkg.version;
      } catch {
        // No package.json
      }

      results.push({ name: entry, version, source: "npm", path: entryPath });
    }
  } catch {
    // node_modules doesn't exist — that's fine
  }

  return results;
}

// ---------------------------------------------------------------------------
// pluginInstall — install a plugin package via npm
// ---------------------------------------------------------------------------

export async function pluginInstall(name: string): Promise<void> {
  const pluginsDir = join(homedir(), ".c0de", "plugins");
  await mkdir(pluginsDir, { recursive: true });

  console.log(`Installing plugin: ${name}...`);

  try {
    const { stdout, stderr } = await execFileAsync("npm", ["install", "--save", name], {
      cwd: pluginsDir,
      timeout: 60_000,
    });

    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);

    console.log(`Plugin "${name}" installed successfully.`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to install plugin "${name}": ${message}`);
    process.exit(1);
  }
}
