// useAgent — manages agent state: running status, permissions, LLM details.
// Data + functions paradigm.
//
// Agent running/paused state is driven by useChat's isStreaming. This hook
// validates the session exists via polling and fetches LLM details.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { LLMDetail } from "../core/types";
import { confirmTool } from "../services/chat";

export type PermissionRequest = {
  toolCallId: string;
  tool: string;
  input: unknown;
};

export type AgentState = {
  isRunning: boolean;
  isPaused: boolean;
  llmDetails: LLMDetail[];
  pendingPermission: PermissionRequest | null;
  approvePermission: () => void;
  denyPermission: () => void;
};

// Polling interval for session validation
const STATUS_POLL_INTERVAL = 5000;

type SessionStatusData = {
  id: string;
  title: string;
};

export function useAgent(sessionId: string): AgentState {
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);

  // Validate session exists via GET /api/sessions/:id (existing endpoint)
  const { data: sessionData } = useQuery<SessionStatusData>({
    queryKey: ["agent-status", sessionId],
    queryFn: async (): Promise<SessionStatusData> => {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) return { id: "", title: "" };
      return res.json();
    },
    enabled: !!sessionId,
    refetchInterval: STATUS_POLL_INTERVAL,
  });

  // Fetch LLM details from GET /api/sessions/:id/llm-details (existing endpoint)
  const { data: llmDetails = [] } = useQuery<LLMDetail[]>({
    queryKey: ["llm-details", sessionId],
    queryFn: async (): Promise<LLMDetail[]> => {
      const res = await fetch(`/api/sessions/${sessionId}/llm-details`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!sessionId && !!sessionData?.id,
    refetchInterval: (query) => {
      // Poll more frequently while agent might be active
      return query.state.data && query.state.data.length > 0 ? STATUS_POLL_INTERVAL : false;
    },
  });

  const approvePermission = useCallback(async () => {
    if (!pendingPermission) return;

    try {
      await confirmTool(pendingPermission.toolCallId, true);
      setPendingPermission(null);
    } catch (err) {
      console.error("Failed to approve permission:", err);
    }
  }, [pendingPermission]);

  const denyPermission = useCallback(async () => {
    if (!pendingPermission) return;

    try {
      await confirmTool(pendingPermission.toolCallId, false);
      setPendingPermission(null);
    } catch (err) {
      console.error("Failed to deny permission:", err);
    }
  }, [pendingPermission]);

  const sessionExists = !!sessionData?.id;

  return {
    isRunning: sessionExists,
    isPaused: false,
    llmDetails,
    pendingPermission,
    approvePermission,
    denyPermission,
  };
}
