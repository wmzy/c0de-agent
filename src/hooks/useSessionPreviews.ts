// useSessionPreviews — fetches last message preview for each session.
// Data + functions paradigm.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { SessionData } from "../services/session";
import { getMessagesForPreview } from "../services/session";

export type SessionPreview = {
  lastMessage: string;
  lastRole: string;
};

export type SessionPreviewsState = {
  previews: Record<string, SessionPreview>;
  getPreview: (sessionId: string) => SessionPreview | null;
};

function extractTextFromContent(content: unknown): string {
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
  if (typeof content === "object" && content !== null && "text" in content) {
    return String((content as { text: unknown }).text ?? "");
  }
  return "";
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

export function useSessionPreviews(sessions: SessionData[]): SessionPreviewsState {
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);

  const { data: rawMap } = useQuery({
    queryKey: ["session-previews", sessionIds.sort().join(",")],
    queryFn: () => getMessagesForPreview(sessionIds),
    enabled: sessionIds.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const previews = useMemo(() => {
    if (!rawMap) return {};
    const result: Record<string, SessionPreview> = {};
    for (const [id, msg] of Object.entries(rawMap)) {
      if (msg) {
        const text = extractTextFromContent(msg.content);
        result[id] = {
          lastMessage: truncate(text, 60),
          lastRole: msg.role,
        };
      }
    }
    return result;
  }, [rawMap]);

  const getPreview = useMemo(() => {
    return (sessionId: string): SessionPreview | null => {
      return previews[sessionId] ?? null;
    };
  }, [previews]);

  return { previews, getPreview };
}
