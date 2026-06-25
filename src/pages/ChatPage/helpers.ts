// ChatPage helpers — pure functions and constants.
// No React dependencies; no side effects.

import type { ToolCallInfo } from "../../hooks/useChat";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const MAX_INPUT_CHARS = 16_000;

// ---------------------------------------------------------------------------
// Message content helpers
// ---------------------------------------------------------------------------

export function getTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { _tag: string; text?: string } =>
          typeof p === "object" && p !== null && "_tag" in p,
      )
      .filter((p) => p._tag === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatToolValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function toolHasOutput(tc: ToolCallInfo): boolean {
  return tc.output !== undefined || tc.error !== undefined;
}

// ---------------------------------------------------------------------------
// Segment parsing (text / code-fence)
// ---------------------------------------------------------------------------

export type Segment =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string };

export function parseSegments(text: string): Segment[] {
  if (!text) return [];
  const segments: Segment[] = [];
  const fence = /```([\w-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({
      type: "code",
      lang: (match[1] || "plain").toLowerCase(),
      content: match[2],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// HTML escape
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Quick-action prompts — fill the input on click from the empty state.
// ---------------------------------------------------------------------------

export type QuickAction = { label: string; prompt: string; icon: string };

export const QUICK_ACTIONS: QuickAction[] = [
  {
    label: "解释这段代码",
    prompt: "请帮我解释下面这段代码：\n\n```\n",
    icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 0 1 .707.293l5.414 5.414a1 1 0 0 1 .293.707V19a2 2 0 0 1-2 2z",
  },
  {
    label: "修复 bug",
    prompt: "我遇到了一个 bug，请帮我分析并修复：\n\n```\n",
    icon: "M11 4a7 7 0 1 0 4 12.708V20a1 1 0 0 0 1.447.894l4-2A1 1 0 0 0 21 18v-1.292A7 7 0 0 0 11 4zm0 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm1 8h-2v-4h2v4z",
  },
  {
    label: "写一个新功能",
    prompt: "请帮我实现以下功能：\n\n",
    icon: "M12 4v16m8-8H4",
  },
  {
    label: "重构代码",
    prompt: "请帮我重构下面的代码，提高可读性与可维护性：\n\n```\n",
    icon: "M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 3a3 3 0 1 1 6 0 3 3 0 0 1-6 0z",
  },
];

// ---------------------------------------------------------------------------
// Slash commands (§3.8) — menu entries for the input autocomplete.
// ---------------------------------------------------------------------------

export type SlashCommandEntry = {
  name: string;
  description: string;
  argsHint: string;
};

export const SLASH_COMMANDS: SlashCommandEntry[] = [
  { name: "compact", description: "手动触发上下文压缩", argsHint: "" },
  { name: "model", description: "切换当前会话模型", argsHint: "<name>" },
  { name: "clear", description: "清除当前会话所有消息", argsHint: "" },
  { name: "help", description: "列出可用命令", argsHint: "" },
  { name: "fork", description: "在指定消息处创建分支", argsHint: "[index]" },
  { name: "config", description: "查看或设置配置值", argsHint: "<key> [value]" },
];
