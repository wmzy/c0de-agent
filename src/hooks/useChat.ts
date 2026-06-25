// useChat — manages chat state: messages, streaming, sending, tool calls.
// Data + functions paradigm via hooks.
//
// Streams SSE events from the chat service and projects them into three
// coordinated UI slices:
//   - `messages` — committed messages + tool call cards (lifecycle tracked
//     by tool call id so we can flip pending -> running -> done/error)
//   - `streamingText` — incremental assistant text deltas (rendered with
//     a typewriter cursor via haze-ui's StreamingText)
//   - `thinkingText` — current thinking delta (rendered with ThinkingIndicator)
//   - `usage` — running token tally from `usage` events

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "../core/types";
import { type ChatEvent, abortChat, confirmTool, sendChatMessage } from "../services/chat";
import { type MessageData, getMessages, parseMessageContent } from "../services/session";

export type PermissionRequest = {
  toolCallId: string;
  tool: string;
  input: unknown;
};

export type ToolCallState = "pending" | "running" | "done" | "error";

export type ToolCallInfo = {
  id: string;
  name: string;
  input: unknown;
  status: ToolCallState;
  output?: unknown;
  error?: string;
};

export type ChatUsage = {
  input: number;
  output: number;
};

export type ChatState = {
  messages: Message[];
  toolCalls: ToolCallInfo[];
  isStreaming: boolean;
  streamingText: string;
  thinkingText: string;
  usage: ChatUsage;
  error: string | null;
  permissionRequest: PermissionRequest | null;
  sendMessage: (content: string) => void;
  abort: () => void;
  abortChat: () => void;
  retry: () => void;
  approveTool: (toolCallId: string, approved: boolean) => Promise<void>;
  denyTool: (toolCallId: string) => Promise<void>;
  clearPermission: () => void;
  clearMessages: () => void;
};

const PENDING_HOLD_MS = 200;

// Slash command detection — commands starting with / are executed by the
// backend agent loop (via executeSlashCommand) instead of being forwarded
// to the LLM. The frontend sends them as-is; no special processing needed.
export function isSlashCommand(content: string): boolean {
  return content.startsWith("/");
}

export function useChat(sessionId: string): ChatState {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [usage, setUsage] = useState<ChatUsage>({ input: 0, output: 0 });
  const [error, setError] = useState<string | null>(null);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const toolCallsRef = useRef<ToolCallInfo[]>([]);
  const runningTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const retryContentRef = useRef<string | null>(null);
  const streamingTextRef = useRef("");

  // Fetch messages from server
  const { isLoading } = useQuery({
    queryKey: ["messages", sessionId],
    queryFn: (): Promise<MessageData[]> => getMessages(sessionId),
    enabled: !!sessionId,
    staleTime: 0,
  });

  // Update local messages when server data changes
  useEffect(() => {
    if (!isLoading) {
      getMessages(sessionId)
        .then((data) => {
          messagesRef.current = data.map(mapMessageData);
          setMessages(messagesRef.current);
        })
        .catch(console.error);
    }
  }, [sessionId, isLoading]);

  const clearRunningTimers = useCallback(() => {
    for (const timer of runningTimersRef.current.values()) {
      clearTimeout(timer);
    }
    runningTimersRef.current.clear();
  }, []);

  const sendMessage = useCallback(
    (content: string) => {
      if (!sessionId || isStreaming) return;

      // Slash commands (e.g. /help, /compact) are sent to the backend as-is.
      // The agent loop detects the / prefix and executes via executeSlashCommand
      // instead of forwarding to the LLM. No frontend processing needed.

      // Add user message locally
      const userMessage: Message = {
        id: `temp-${Date.now()}`,
        role: "user",
        content,
        createdAt: Date.now(),
      };
      messagesRef.current = [...messagesRef.current, userMessage];
      toolCallsRef.current = [];
      setMessages([...messagesRef.current]);
      setToolCalls([]);
      setStreamingText("");
      setThinkingText("");
      streamingTextRef.current = "";
      setError(null);
      setIsStreaming(true);
      retryContentRef.current = content;

      const handleEvent = (event: ChatEvent) => {
        switch (event._tag) {
          case "text_delta":
            streamingTextRef.current += event.text;
            setStreamingText(streamingTextRef.current);
            break;
          case "thinking":
            setThinkingText(event.text);
            break;
          case "tool_call": {
            const info: ToolCallInfo = {
              id: event.id,
              name: event.tool,
              input: event.input,
              status: "pending",
            };
            toolCallsRef.current = [...toolCallsRef.current, info];
            setToolCalls([...toolCallsRef.current]);

            // Flip to running after a short hold so the user sees the
            // "pending -> running" transition.
            const timer = setTimeout(() => {
              toolCallsRef.current = toolCallsRef.current.map((tc) =>
                tc.id === event.id ? { ...tc, status: "running" } : tc,
              );
              setToolCalls([...toolCallsRef.current]);
              runningTimersRef.current.delete(event.id);
            }, PENDING_HOLD_MS);
            runningTimersRef.current.set(event.id, timer);
            break;
          }
          case "tool_result": {
            const timer = runningTimersRef.current.get(event.id);
            if (timer) {
              clearTimeout(timer);
              runningTimersRef.current.delete(event.id);
            }
            const failed = isToolFailure(event.output);
            toolCallsRef.current = toolCallsRef.current.map((tc) =>
              tc.id === event.id
                ? {
                    ...tc,
                    status: failed ? "error" : "done",
                    output: event.output,
                    error: failed ? extractErrorMessage(event.output) : undefined,
                  }
                : tc,
            );
            setToolCalls([...toolCallsRef.current]);
            break;
          }
          case "usage":
            setUsage((prev) => ({
              input: prev.input + (event.input || 0),
              output: prev.output + (event.output || 0),
            }));
            break;
          case "permission_required":
            setPermissionRequest({
              toolCallId: event.toolCallId,
              tool: event.tool,
              input: event.input,
            });
            break;
          case "warning":
            // Surface anti-pattern warnings as thinking text so the user
            // sees them inline without interrupting the streaming flow.
            setThinkingText((prev) => `${prev ? `${prev}\n\n` : ""}[Warning: ${event.message}]`);
            break;
          case "error":
            setError(
              event.error instanceof Error
                ? event.error.message
                : typeof event.error === "object" &&
                    event.error !== null &&
                    "message" in event.error
                  ? String((event.error as { message: unknown }).message)
                  : "Unknown error",
            );
            setIsStreaming(false);
            break;
          case "done":
            setIsStreaming(false);
            setStreamingText("");
            setThinkingText("");
            clearRunningTimers();
            // Persist the streamed assistant text and pending tool calls
            // as a committed assistant message so they survive refetch.
            if (streamingTextRef.current.trim() || toolCallsRef.current.length > 0) {
              const assistantMessage: Message = {
                id: `assistant-${Date.now()}`,
                role: "assistant",
                content: streamingTextRef.current,
                toolCalls:
                  toolCallsRef.current.length > 0
                    ? toolCallsRef.current.map((tc) => ({
                        id: tc.id,
                        name: tc.name,
                        arguments: safeStringify(tc.input),
                        output: tc.output !== undefined ? safeStringify(tc.output) : undefined,
                        error: tc.error,
                        status: tc.status,
                      }))
                    : undefined,
                createdAt: Date.now(),
              };
              messagesRef.current = [...messagesRef.current, assistantMessage];
              setMessages([...messagesRef.current]);
              streamingTextRef.current = "";
              setToolCalls([]);
              toolCallsRef.current = [];
            }
            // Invalidate messages query to refetch
            queryClient.invalidateQueries({
              queryKey: ["messages", sessionId],
            });
            break;
        }
      };

      abortRef.current = sendChatMessage(sessionId, content, handleEvent);
    },
    [sessionId, isStreaming, queryClient, clearRunningTimers],
  );

  const abortChatFn = useCallback(() => {
    if (sessionId) {
      abortChat(sessionId).catch(console.error);
    }
    if (abortRef.current) {
      abortRef.current.abort();
    }
    clearRunningTimers();
    streamingTextRef.current = "";
    setIsStreaming(false);
    setStreamingText("");
    setThinkingText("");
  }, [sessionId, clearRunningTimers]);

  const clearMessages = useCallback(() => {
    messagesRef.current = [];
    toolCallsRef.current = [];
    retryContentRef.current = null;
    streamingTextRef.current = "";
    setMessages([]);
    setToolCalls([]);
    setStreamingText("");
    setThinkingText("");
    setUsage({ input: 0, output: 0 });
    setError(null);
    setPendingRetry(null);
  }, []);

  // Abort function alias (ChatPage uses this name)
  const abort = useCallback(() => {
    abortChatFn();
  }, [abortChatFn]);

  // Retry the last user message after an error.
  const retry = useCallback(() => {
    const content = retryContentRef.current ?? pendingRetry;
    if (!content || isStreaming) return;
    // Drop the user message we optimistically added when the original send
    // failed so the retry doesn't duplicate it.
    messagesRef.current = messagesRef.current.filter(
      (m) => !(m.id.startsWith("temp-") && m.content === content),
    );
    setMessages([...messagesRef.current]);
    sendMessage(content);
  }, [pendingRetry, isStreaming, sendMessage]);

  // Approve tool permission
  const approveTool = useCallback(async (toolCallId: string, approved: boolean) => {
    await confirmTool(toolCallId, approved);
    setPermissionRequest(null);
  }, []);

  // Deny tool permission
  const denyTool = useCallback(async (toolCallId: string) => {
    await confirmTool(toolCallId, false);
    setPermissionRequest(null);
  }, []);

  // Clear permission request
  const clearPermission = useCallback(() => {
    setPermissionRequest(null);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearRunningTimers();
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, [clearRunningTimers]);

  // Reset state when session changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is a function param, not outer-scope mutable
  useEffect(() => {
    messagesRef.current = [];
    toolCallsRef.current = [];
    retryContentRef.current = null;
    streamingTextRef.current = "";
    setMessages([]);
    setToolCalls([]);
    setStreamingText("");
    setThinkingText("");
    setUsage({ input: 0, output: 0 });
    setError(null);
    setIsStreaming(false);
    setPendingRetry(null);
  }, [sessionId]);

  // Track the last failed message so retry can pick it up.
  useEffect(() => {
    if (error && retryContentRef.current) {
      setPendingRetry(retryContentRef.current);
    }
  }, [error]);

  return {
    messages,
    toolCalls,
    isStreaming,
    streamingText,
    thinkingText,
    usage,
    error,
    permissionRequest,
    sendMessage,
    abort,
    abortChat: abortChatFn,
    retry,
    approveTool,
    denyTool,
    clearPermission,
    clearMessages,
  };
}

function mapMessageData(m: MessageData): Message {
  return {
    id: m.id,
    role: m.role as Message["role"],
    content: parseMessageContent(m.content),
    toolCallId: m.toolCallId,
    toolCalls: m.toolCalls as Message["toolCalls"],
    createdAt: new Date(m.createdAt).getTime(),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isToolFailure(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  if (o.error) return true;
  if (o.success === false) return true;
  if (typeof o.code === "string" && o.code.startsWith("ERR_")) return true;
  return false;
}

function extractErrorMessage(output: unknown): string {
  if (!output || typeof output !== "object") return "Tool failed";
  const o = output as Record<string, unknown>;
  if (typeof o.error === "string") return o.error;
  if (o.error && typeof o.error === "object") {
    const errObj = o.error as Record<string, unknown>;
    if (typeof errObj.message === "string") return errObj.message;
  }
  if (typeof o.message === "string") return o.message;
  return "Tool failed";
}
