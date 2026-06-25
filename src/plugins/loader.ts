// Plugin discovery and loading (§7.4).
//
// Discovers plugins from three sources (in order):
//   1. Project-local:  <projectDir>/.c0de/plugins/
//   2. npm packages:   c0de-plugin-* naming convention
//   3. Global:         ~/.c0de/plugins/
//
// Each discovered entry point is loaded via loadPlugin(), then activated
// with activatePlugin() which calls the plugin's setup() with a fresh
// PluginContext.
//
// Conventions: data + functions, no class.

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Plugin, PluginContext } from "./types";

// ---------------------------------------------------------------------------
// discoverPlugins — enumerate all available plugins from the three sources.
//
// Returns a flat list in priority order (project-local first, then npm, then
// global) so that project-local wins on name collision.
// ---------------------------------------------------------------------------

export async function discoverPlugins(projectDir: string): Promise<PluginSource[]> {
  const sources: PluginSource[] = [];

  // 1. Project-local .c0de/plugins/
  const projectPluginDir = resolve(projectDir, ".c0de", "plugins");
  sources.push(...(await discoverFromDirectory(projectPluginDir, "project")));

  // 2. npm packages (c0de-plugin-*)
  sources.push(...(await discoverFromNpm(projectDir)));

  // 3. Global ~/.c0de/plugins/
  const globalPluginDir = resolve(homedir(), ".c0de", "plugins");
  sources.push(...(await discoverFromDirectory(globalPluginDir, "global")));

  return sources;
}

// ---------------------------------------------------------------------------
// PluginSource — internal descriptor for a discovered but not yet loaded
// plugin, carrying metadata needed by loadPlugin.
// ---------------------------------------------------------------------------

export type PluginSource = {
  name: string;
  path: string;
  source: "project" | "npm" | "global";
};

// ---------------------------------------------------------------------------
// discoverFromDirectory — scan a local directory for plugin entry points.
//
// Each subdirectory or .ts/.js file is a candidate:
//   - If it's a directory we look for index.ts, index.js, or
//     <name>.ts / <name>.js inside.
//   - If it's a single .ts / .js file that is the entry point.
// ---------------------------------------------------------------------------

async function discoverFromDirectory(
  dir: string,
  source: PluginSource["source"],
): Promise<PluginSource[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: PluginSource[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Check for index.ts / index.js / <name>.ts inside
        const subPath = join(dir, entry.name);
        const resolved = await resolvePluginEntry(subPath, entry.name);
        if (resolved) {
          results.push({ name: entry.name, path: resolved, source });
        }
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        const name = entry.name.replace(/\.(ts|js)$/, "");
        results.push({ name, path: join(dir, entry.name), source });
      }
    }

    return results;
  } catch (_err) {
    // Directory doesn't exist or can't be read — return empty
    return [];
  }
}

// ---------------------------------------------------------------------------
// resolvePluginEntry — given a directory, find an acceptable entry-point
// file inside it.
// ---------------------------------------------------------------------------

async function resolvePluginEntry(dir: string, name: string): Promise<string | null> {
  const candidates = [
    join(dir, "index.ts"),
    join(dir, "index.js"),
    join(dir, `${name}.ts`),
    join(dir, `${name}.js`),
  ];

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// discoverFromNpm — discover packages following the c0de-plugin-* convention
// by scanning node_modules.
//
// This is a lightweight scan: we look at <projectDir>/node_modules for
// directories matching "c0de-plugin-*" and check their package.json for a
// valid main/module entry point.
// ---------------------------------------------------------------------------

async function discoverFromNpm(projectDir: string): Promise<PluginSource[]> {
  const nmDir = resolve(projectDir, "node_modules");
  const results: PluginSource[] = [];

  try {
    const entries = await readdir(nmDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("c0de-plugin-")) continue;

      const pkgPath = join(nmDir, entry.name, "package.json");
      try {
        const pkgRaw = await readFile(pkgPath, "utf-8");
        const pkg = JSON.parse(pkgRaw);
        const main = pkg.main || pkg.module || "index.js";
        const entryPath = resolve(join(nmDir, entry.name, main));

        // Drop the "c0de-plugin-" prefix for the plugin name
        const name = entry.name.slice("c0de-plugin-".length);
        results.push({ name, path: entryPath, source: "npm" });
      } catch {
        // Invalid or missing package.json — skip
        continue;
      }
    }
  } catch {
    // No node_modules — skip
  }

  return results;
}

// ---------------------------------------------------------------------------
// loadPlugin — dynamically import a plugin module from its entry path.
//
// Expects the module to export a `plugin` or `default` field conforming to
// the Plugin type. Returns the loaded Plugin descriptor.
// ---------------------------------------------------------------------------

export async function loadPlugin(path: string): Promise<Plugin> {
  // Dynamic import — works for both local files and npm packages resolved
  // to absolute paths.
  const mod = await import(path);

  // Accept either a named `plugin` export or a `default` export
  const plugin: Plugin | undefined = mod.plugin ?? mod.default;

  if (!plugin) {
    throw new Error(`loadPlugin: module at "${path}" has no "plugin" or "default" export`);
  }

  if (!plugin.name || !plugin.version || typeof plugin.setup !== "function") {
    throw new Error(
      `loadPlugin: module at "${path}" does not conform to Plugin type ` +
        `(name=${typeof plugin.name}, version=${typeof plugin.version}, ` +
        `setup=${typeof plugin.setup})`,
    );
  }

  return plugin;
}

// ---------------------------------------------------------------------------
// activatePlugin — run a plugin's setup() with a PluginContext.
//
// The context is backed by the provided PluginRegistry: tools, providers,
// and hooks registered by the plugin are permanently attached to that
// registry once setup() completes.
// ---------------------------------------------------------------------------

export async function activatePlugin(plugin: Plugin, ctx: PluginContext): Promise<void> {
  // setup may be sync (void) or async (Promise<void>); Promise.resolve
  // handles both cases without ad-hoc type narrowing.
  await Promise.resolve(plugin.setup(ctx));
}
