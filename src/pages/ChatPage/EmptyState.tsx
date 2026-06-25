// EmptyState + message display sub-components.
// HeroIcon, StreamingAssistantBlock, ToolCallBlock, MessageBubble.
// Receives data via props — no direct hook access.

import { cx } from "@linaria/core";
import { CodeBlock, Spinner, StreamingText, ThinkingIndicator, ToolCallCard, ChatMessage } from "haze-ui";
import { type ChatState, type ToolCallInfo } from "../../hooks/useChat";
import { formatTimestamp, formatToolValue, toolHasOutput, QUICK_ACTIONS } from "./helpers";
import { MessageContent } from "./MessageContent";
import {
  messageRow,
  streamingBubble,
  thinkingBubble,
  toolCallContainer,
  toolCallStack,
} from "./styles";

// ---------------------------------------------------------------------------
// HeroIcon — stylized 72x72 SVG combining chat + code motifs
// ---------------------------------------------------------------------------

export function HeroIcon() {
  return (
    <svg
      className="c0de-hero__icon"
      viewBox="0 0 72 72"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="c0de-hero-grad" x1="0" y1="0" x2="72" y2="72" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#58a6ff" />
          <stop offset="100%" stopColor="#d2a8ff" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="60" height="60" rx="16" fill="url(#c0de-hero-grad)" opacity="0.12" />
      <rect
        x="6"
        y="6"
        width="60"
        height="60"
        rx="16"
        stroke="url(#c0de-hero-grad)"
        strokeWidth="1.5"
        opacity="0.5"
      />
      <path
        d="M22 22h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H30l-6 6v-6h-2a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4z"
        stroke="url(#c0de-hero-grad)"
        strokeWidth="2.2"
        fill="none"
        strokeLinejoin="round"
      />
      <path
        d="M30 31l-3 3 3 3M42 31l3 3-3 3"
        stroke="url(#c0de-hero-grad)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="38.5"
        y1="29"
        x2="33.5"
        y2="39"
        stroke="url(#c0de-hero-grad)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Empty state — hero + quick-action chips
// ---------------------------------------------------------------------------

export function EmptyState({ onChipSelect }: { onChipSelect: (prompt: string) => void }) {
  return (
    <div className="c0de-hero">
      <HeroIcon />
      <h1 className="c0de-hero__title">开始对话</h1>
      <p className="c0de-hero__hint">
        输入消息与 AI 助手对话，它将帮助你编写、调试和理解代码。
      </p>
      <div className="c0de-hero__chips">
        {QUICK_ACTIONS.map((qa) => (
          <button
            key={qa.label}
            type="button"
            className="c0de-hero__chip"
            onClick={() => onChipSelect(qa.prompt)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={qa.icon} />
            </svg>
            {qa.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StreamingAssistantBlock — live streaming bubble with thinking + tool calls
// ---------------------------------------------------------------------------

export function StreamingAssistantBlock({ chat }: { chat: ChatState }) {
  const { isStreaming, streamingText, thinkingText, toolCalls } = chat;

  if (!isStreaming) return null;

  return (
    <>
      {thinkingText ? (
        <div className={cx(messageRow, thinkingBubble)}>
          <ThinkingIndicator text="思考中..." />
          {thinkingText ? (
            <span className="c0de-thinking-text">{thinkingText}</span>
          ) : null}
        </div>
      ) : null}

      {toolCalls.length > 0 ? (
        <div className={cx(messageRow, toolCallStack)}>
          {toolCalls.map((tc) => (
            <ToolCallBlock key={tc.id} tc={tc} />
          ))}
        </div>
      ) : null}

      {streamingText ? (
        <div className={cx(messageRow, streamingBubble)}>
          <StreamingText text={streamingText} showCursor={true} />
        </div>
      ) : !thinkingText && toolCalls.length === 0 ? (
        <div className={cx(messageRow, streamingBubble)}>
          <Spinner size="sm" />
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ToolCallBlock — single tool call card
// ---------------------------------------------------------------------------

export function ToolCallBlock({ tc }: { tc: ToolCallInfo }) {
  const inputText = formatToolValue(tc.input);
  const outputText = toolHasOutput(tc) ? (tc.error ? tc.error : formatToolValue(tc.output)) : "";
  return (
    <div className={toolCallContainer}>
      <ToolCallCard
        name={tc.name}
        status={tc.status}
        input={inputText ? <CodeBlock language="json">{inputText}</CodeBlock> : undefined}
        output={outputText ? <CodeBlock language="json">{outputText}</CodeBlock> : undefined}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble — single message row (avatar + content + optional tool calls)
// ---------------------------------------------------------------------------

export function MessageBubble({
  role,
  text,
  status,
  timestamp,
  toolCalls,
}: {
  role: "user" | "assistant" | "system";
  text: string;
  status?: "sending" | "sent" | "error";
  timestamp?: number;
  toolCalls?: {
    id: string;
    name: string;
    arguments: string;
    output?: string;
    error?: string;
    status?: "pending" | "running" | "done" | "error";
  }[];
}) {
  const avatarLabel = role === "user" ? "你" : role === "system" ? "S" : "AI";
  const avatar = (
    <span
      className={`c0de-msg-avatar c0de-msg-avatar--${role}`}
      aria-hidden="true"
    >
      {avatarLabel}
    </span>
  );
  const name =
    role === "user" ? "You" : role === "system" ? "System" : "Assistant";
  return (
    <div className={messageRow}>
      <ChatMessage
        role={role}
        avatar={avatar}
        name={name}
        timestamp={timestamp ? formatTimestamp(timestamp) : undefined}
        status={status}
      >
        <MessageContent text={text} isUser={role === "user"} />
      </ChatMessage>
      {toolCalls && toolCalls.length > 0 ? (
        <div className={toolCallStack} style={{ marginTop: 8 }}>
          {toolCalls.map((tc) => (
            <div className={toolCallContainer} key={tc.id}>
              <ToolCallCard
                name={tc.name}
                status={tc.status ?? "done"}
                input={
                  tc.arguments ? <CodeBlock language="json">{tc.arguments}</CodeBlock> : undefined
                }
                output={
                  tc.error ? (
                    <CodeBlock language="text">{tc.error}</CodeBlock>
                  ) : tc.output ? (
                    <CodeBlock language="json">{tc.output}</CodeBlock>
                  ) : undefined
                }
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
