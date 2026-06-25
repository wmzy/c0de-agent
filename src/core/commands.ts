// Slash commands (spec §3.8).
//
// Built-in commands:
//   /compact          — manually trigger context compaction
//   /model <name>     — switch the current session's model
//   /clear            — clear all messages in the current session
//   /help             — list available commands
//   /fork [index]     — create a branch at the given message index
//   /config <key> [value] — view or set a configuration value
//
// Conventions: data + functions, no class, no this, no enum.

import { compactMessages, estimateMessagesTokens } from "./context";
import type { CommandContext, CommandResult, SlashCommand } from "./types";

// ---------------------------------------------------------------------------
// Built-in slash commands
// ---------------------------------------------------------------------------

const compactCommand: SlashCommand = {
  name: "compact",
  description: "Manually trigger context compaction",
  execute: async (_args, ctx): Promise<CommandResult> => {
    const budget = ctx.agent.tokenBudget;
    const compaction = ctx.config.compaction;

    if (!compaction.enabled) {
      return { _tag: "ok", output: "Compaction is disabled in configuration." };
    }

    const messages = ctx.agent.messages;
    if (messages.length === 0) {
      return { _tag: "ok", output: "No messages to compact." };
    }

    try {
      ctx.agent.messages = await compactMessages(messages, compaction);
      const tokenEst = estimateMessagesTokens(ctx.agent.messages);
      return {
        _tag: "ok",
        output: `Compacted ${messages.length} → ${ctx.agent.messages.length} messages (~${tokenEst} tokens).`,
      };
    } catch (err) {
      return {
        _tag: "error",
        message: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

const modelCommand: SlashCommand = {
  name: "model",
  description: "Switch the current session model (/model <name>)",
  execute: async (args, ctx): Promise<CommandResult> => {
    const name = typeof args === "string" ? args.trim() : "";
    if (!name) {
      return { _tag: "ok", output: `Current model: ${ctx.config.defaultModel}` };
    }
    // The agent config is wired at a higher level; we mutate the config
    // and report the change. The caller must re-run the agent for it to
    // take effect on the next LLM call.
    ctx.config.defaultModel = name;
    return { _tag: "ok", output: `Model switched to: ${name}` };
  },
};

const clearCommand: SlashCommand = {
  name: "clear",
  description: "Clear all messages in the current session",
  execute: async (_args, ctx): Promise<CommandResult> => {
    const count = ctx.agent.messages.length;
    ctx.agent.messages = [];
    ctx.agent.tokenBudget.used = 0;
    return { _tag: "ok", output: `Cleared ${count} messages.` };
  },
};

const helpCommand: SlashCommand = {
  name: "help",
  description: "List available slash commands",
  execute: async (_args, ctx): Promise<CommandResult> => {
    const lines = BUILTIN_COMMANDS.map((cmd) => `  /${cmd.name}  —  ${cmd.description}`);
    return { _tag: "ok", output: ["Available commands:", ...lines].join("\n") };
  },
};

const forkCommand: SlashCommand = {
  name: "fork",
  description: "Create a branch at a message index (/fork [index])",
  execute: async (args, ctx): Promise<CommandResult> => {
    const idxStr = typeof args === "string" ? args.trim() : "";
    const maxIndex = ctx.agent.messages.length - 1;

    if (maxIndex < 0) {
      return { _tag: "error", message: "No messages to fork from." };
    }

    const branchPoint = idxStr ? Number.parseInt(idxStr, 10) : maxIndex;
    if (isNaN(branchPoint) || branchPoint < 0 || branchPoint > maxIndex) {
      return {
        _tag: "error",
        message: `Invalid message index: ${idxStr}. Valid range: 0–${maxIndex}.`,
      };
    }

    // Fork is a session-level operation that requires the DB layer.
    // Record the fork intent in session metadata so the caller (server/CLI)
    // can execute it. We return a 'forked' result with the intent.
    const forkId = crypto.randomUUID();
    return {
      _tag: "forked",
      sessionId: forkId,
      branchPoint,
    };
  },
};

const configCommand: SlashCommand = {
  name: "config",
  description: "View or set a configuration value (/config <key> [value])",
  execute: async (args, ctx): Promise<CommandResult> => {
    const argStr = typeof args === "string" ? args.trim() : "";
    if (!argStr) {
      // Show all config keys
      const keys = Object.keys(ctx.config).sort();
      const lines = keys.map((k) => {
        const val = (ctx.config as Record<string, unknown>)[k];
        const display = typeof val === "object" ? JSON.stringify(val) : String(val);
        return `  ${k} = ${display}`;
      });
      return { _tag: "ok", output: ["Configuration:", ...lines].join("\n") };
    }

    const spaceIdx = argStr.indexOf(" ");
    const key = spaceIdx === -1 ? argStr : argStr.slice(0, spaceIdx);
    const value = spaceIdx === -1 ? undefined : argStr.slice(spaceIdx + 1).trim();

    const cfg = ctx.config as Record<string, unknown>;
    if (!(key in cfg)) {
      return { _tag: "error", message: `Unknown config key: ${key}` };
    }

    if (value === undefined) {
      // Read
      const val = cfg[key];
      const display = typeof val === "object" ? JSON.stringify(val, null, 2) : String(val);
      return { _tag: "ok", output: `${key} = ${display}` };
    }

    // Write — attempt to parse as JSON, fall back to string
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    cfg[key] = parsed;
    return {
      _tag: "ok",
      output: `Set ${key} = ${typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed)}`,
    };
  },
};

const thinkCommand: SlashCommand = {
  name: "think",
  description: "Set think mode (/think quick|thorough|creative|auto|none)",
  execute: async (args, ctx): Promise<CommandResult> => {
    const mode = typeof args === "string" ? args.trim().toLowerCase() : "";
    const validModes = ["quick", "thorough", "creative", "auto", "none"];

    if (!mode) {
      // Show current mode
      const current = ctx.agent.thinkMode.mode._tag;
      const history = ctx.agent.thinkMode.history;
      const lastSwitch = history.length > 0 ? history[history.length - 1] : null;
      const lines = [
        `Current think mode: ${current}`,
        `Valid modes: ${validModes.join(", ")}`,
      ];
      if (lastSwitch) {
        const ago = Date.now() - lastSwitch.timestamp;
        const secs = Math.round(ago / 1000);
        lines.push(`Last switch: ${lastSwitch.from} → ${lastSwitch.to} (${secs}s ago, reason: ${lastSwitch.reason})`);
      }
      return { _tag: "ok", output: lines.join("\n") };
    }

    if (!validModes.includes(mode)) {
      return {
        _tag: "error",
        message: `Invalid mode: "${mode}". Valid modes: ${validModes.join(", ")}`,
      };
    }

    // Import here to avoid circular dependency — this is safe because
    // commands.ts is a leaf module that core/types doesn't depend on.
    const { switchThinkMode } = await import("../agent/agent");
    ctx.agent.thinkMode = switchThinkMode(
      ctx.agent.thinkMode,
      { _tag: mode as "quick" | "thorough" | "creative" | "auto" | "none" },
      "user",
    );

    return {
      _tag: "ok",
      output: `Think mode set to: ${mode}${mode === "none" ? " (thinking disabled)" : ""}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const BUILTIN_COMMANDS: SlashCommand[] = [
  compactCommand,
  modelCommand,
  clearCommand,
  helpCommand,
  forkCommand,
  configCommand,
  thinkCommand,
];

// ---------------------------------------------------------------------------
// executeSlashCommand — look up by name and run
// ---------------------------------------------------------------------------

export async function executeSlashCommand(
  name: string,
  args: string,
  ctx: CommandContext,
  commands: SlashCommand[] = BUILTIN_COMMANDS,
): Promise<CommandResult> {
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    return {
      _tag: "error",
      message: `Unknown command: /${name}. Type /help for available commands.`,
    };
  }
  return cmd.execute(args, ctx);
}

// ---------------------------------------------------------------------------
// parseSlashCommand — extract name + args from raw user text
// ---------------------------------------------------------------------------

export function parseSlashCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const spaceIdx = text.indexOf(" ");
  const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
  return { name, args };
}
