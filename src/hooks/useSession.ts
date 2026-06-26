// useSession — manages session list and active session selection.
// Data + functions paradigm.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  type SessionData,
  createSession,
  deleteSession,
  forkSession,
  listSessions,
} from "../services/session";

export type SessionState = {
  sessions: SessionData[];
  activeSessionId: string | null;
  activeProjectId: string | null;
  setActiveSession: (id: string) => void;
  setActiveProject: (id: string | null) => void;
  createSession: (title?: string, projectId?: string) => Promise<SessionData>;
  createNewSession: () => Promise<SessionData>;
  deleteSession: (id: string) => Promise<void>;
  forkSession: (sessionId: string, branchPoint: number) => Promise<SessionData>;
  fork: (sessionId: string, branchPoint: number) => Promise<void>;
  isLoading: boolean;
};

const STORAGE_KEY = "c0de-active-session";

export function useSession(): SessionState {
  const queryClient = useQueryClient();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(STORAGE_KEY);
  });

  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("c0de-active-project");
  });

  const { data: sessions = [], isLoading } = useQuery<SessionData[]>({
    queryKey: ["sessions", activeProjectId],
    queryFn: () => listSessions(activeProjectId ?? undefined),
  });

  const setActiveProject = useCallback((id: string | null) => {
    setActiveProjectId(id);
    if (id) {
      localStorage.setItem("c0de-active-project", id);
    } else {
      localStorage.removeItem("c0de-active-project");
    }
    // Clear active session when project changes
    setActiveSessionId(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const createMutation = useMutation({
    mutationFn: createSession,
    onSuccess: (newSession) => {
      queryClient.setQueryData<SessionData[]>(["sessions"], (old = []) => [...old, newSession]);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSession,
    onSuccess: (_, deletedId) => {
      queryClient.setQueryData<SessionData[]>(["sessions"], (old = []) =>
        old.filter((s) => s.id !== deletedId),
      );
      // If deleted session was active, clear selection
      if (activeSessionId === deletedId) {
        setActiveSessionId(null);
        localStorage.removeItem(STORAGE_KEY);
      }
    },
  });

  const forkMutation = useMutation({
    mutationFn: ({ sessionId, branchPoint }: { sessionId: string; branchPoint: number }) =>
      forkSession(sessionId, branchPoint),
    onSuccess: (newSession) => {
      queryClient.setQueryData<SessionData[]>(["sessions"], (old = []) => [...old, newSession]);
    },
  });

  const setActiveSession = useCallback((id: string) => {
    setActiveSessionId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  const createSessionFn = useCallback(
    async (title?: string, projectId?: string): Promise<SessionData> => {
      const actualProjectId = projectId ?? activeProjectId ?? undefined;
      const newSession = await createMutation.mutateAsync({ title, projectId: actualProjectId });
      setActiveSession(newSession.id);
      return newSession;
    },
    [createMutation, setActiveSession, activeProjectId],
  );

  const deleteSessionFn = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutation.mutateAsync(id);
      // If deleting the active session, select another or clear
      if (activeSessionId === id) {
        const remaining = sessions.filter((s) => s.id !== id);
        if (remaining.length > 0) {
          setActiveSession(remaining[0].id);
        } else {
          setActiveSessionId(null);
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    },
    [deleteMutation, activeSessionId, sessions, setActiveSession],
  );

  const forkSessionFn = useCallback(
    async (sessionId: string, branchPoint: number): Promise<SessionData> => {
      const newSession = await forkMutation.mutateAsync({
        sessionId,
        branchPoint,
      });
      setActiveSession(newSession.id);
      return newSession;
    },
    [forkMutation, setActiveSession],
  );

  // Alias for createNewSession (ChatPage uses this name)
  const createNewSession = useCallback(async (): Promise<SessionData> => {
    return createSessionFn();
  }, [createSessionFn]);

  // Alias for fork with different signature (ChatPage uses this)
  const fork = useCallback(
    async (sessionId: string, branchPoint: number): Promise<void> => {
      await forkMutation.mutateAsync({ sessionId, branchPoint });
    },
    [forkMutation],
  );

  // Auto-select first session if none selected and sessions are loaded
  useEffect(() => {
    if (!isLoading && sessions.length > 0 && !activeSessionId) {
      setActiveSession(sessions[0].id);
    }
  }, [isLoading, sessions, activeSessionId, setActiveSession]);

  return {
    sessions,
    activeSessionId,
    activeProjectId,
    setActiveSession,
    setActiveProject,
    createSession: createSessionFn,
    createNewSession,
    deleteSession: deleteSessionFn,
    forkSession: forkSessionFn,
    fork,
    isLoading,
  };
}
