// CLI main entry — `c0de` command (design spec §11).
//
// Parses process.argv and dispatches to the appropriate command handler.
//
// Usage:
//   c0de [serve]          — start Hono HTTP server
//   c0de chat <message>   — quick question, text output
//   c0de init             — initialize .c0de/config.json
//   c0de config get [key] — view config
//   c0de config set k v   — set config value
//   c0de plugin list       — list plugins
//   c0de plugin install X  — install plugin via npm
//
// Data + functions: no class, no this, no enum.

import { acp } from "./commands/acp";
import { attach } from "./commands/attach";
import { chat } from "./commands/chat";
import { configGet, configSet } from "./commands/config";
import { init as initCmd } from "./commands/init";
import { pluginInstall, pluginList } from "./commands/plugin";
import { serve } from "./commands/serve";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function cli(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 0) {
    // No arguments: start server with browser open
    await serve({ open: true });
    return;
  }

  const command = args[0];

  switch (command) {
    case "serve": {
      const portIndex = args.indexOf("--port");
      const port = portIndex !== -1 ? Number(args[portIndex + 1]) : undefined;
      const hostIndex = args.indexOf("--host");
      const host = hostIndex !== -1 ? args[hostIndex + 1] : undefined;
      const open = args.includes("--open") || args.includes("-o");

      await serve({ port, host, open });
      break;
    }

    case "chat": {
      const chatArgs = args.slice(1);
      await chat(chatArgs);
      break;
    }

    case "init": {
      const forceIndex = args.indexOf("--force");
      const dirIndex = args.indexOf("--dir");
      await initCmd({
        force: forceIndex !== -1,
        dir: dirIndex !== -1 ? args[dirIndex + 1] : undefined,
      });
      break;
    }

    case "acp": {
      await acp();
      break;
    }

    case "attach": {
      const url = args[1];
      if (!url) {
        console.error("Usage: c0de attach <url> [message]");
        process.exit(1);
      }
      const message = args[2];
      await attach(url, message);
      break;
    }

    case "plugin": {
      const sub = args[1];

      if (sub === "list") {
        const plugins = await pluginList(process.cwd());
        if (plugins.length === 0) {
          console.log("No plugins installed.");
        } else {
          for (const p of plugins) {
            const version = p.version ? `@${p.version}` : "";
            console.log(`  ${p.name}${version}  [${p.source}]`);
          }
        }
      } else if (sub === "install") {
        const name = args[2];
        if (!name) {
          console.error("Usage: c0de plugin install <name>");
          process.exit(1);
        }
        await pluginInstall(name);
      } else {
        console.error("Usage: c0de plugin list | c0de plugin install <name>");
        process.exit(1);
      }
      break;
    }

    case "config": {
      const sub = args[1];

      if (sub === "get") {
        const key = args[2];
        await configGet(key);
      } else if (sub === "set") {
        const key = args[2];
        const value = args[3];
        if (!key || value === undefined) {
          console.error("Usage: c0de config set <key> <value>");
          process.exit(1);
        }
        await configSet(key, value);
      } else {
        console.error("Usage: c0de config get [key] | c0de config set <key> <value>");
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.error("Usage:");
      console.error("  c0de                          — start server + open browser");
      console.error("  c0de serve                    — start server only");
      console.error("  c0de chat <message>           — quick question");
      console.error("  c0de init                     — initialize config");
      console.error("  c0de config get [key]         — view config");
      console.error("  c0de config set <key> <value>  — set config value");
      console.error(
        "  c0de acp                      — start ACP mode (JSON-RPC over stdin/stdout)",
      );
      console.error("  c0de plugin list              — list installed plugins");
      console.error("  c0de plugin install <name>    — install a plugin via npm");
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-execute when invoked directly
// ---------------------------------------------------------------------------

const isMainModule = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isMainModule) {
  cli().catch((err: unknown) => {
    console.error("c0de:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
