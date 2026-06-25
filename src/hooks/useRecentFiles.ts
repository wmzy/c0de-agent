// useRecentFiles — localStorage-backed recent file tracking.
// Data + functions paradigm. Max 10 entries, deduped, most-recent-first.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "c0de/recent-files";
const MAX_RECENT = 10;

export type RecentFile = {
  path: string;
  name: string;
  openedAt: number; // epoch ms
};

// ---------------------------------------------------------------------------
// Storage helpers — pure functions
// ---------------------------------------------------------------------------

function readStorage(): RecentFile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each entry has required fields
    return parsed.filter(
      (e): e is RecentFile =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RecentFile).path === "string" &&
        typeof (e as RecentFile).name === "string" &&
        typeof (e as RecentFile).openedAt === "number",
    );
  } catch {
    return [];
  }
}

function writeStorage(entries: RecentFile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

function addEntry(existing: RecentFile[], path: string, name: string): RecentFile[] {
  const now = Date.now();
  // Remove duplicate by path, then prepend new entry
  const deduped = existing.filter((e) => e.path !== path);
  return [{ path, name, openedAt: now }, ...deduped].slice(0, MAX_RECENT);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type RecentFilesState = {
  recentFiles: RecentFile[];
  trackFile: (path: string) => void;
  clearRecent: () => void;
  removeRecent: (path: string) => void;
};

export function useRecentFiles(): RecentFilesState {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(readStorage);

  // Sync to localStorage on every change
  useEffect(() => {
    writeStorage(recentFiles);
  }, [recentFiles]);

  const trackFile = useCallback((path: string) => {
    const name = path.split("/").filter(Boolean).pop() ?? path;
    setRecentFiles((prev) => addEntry(prev, path, name));
  }, []);

  const clearRecent = useCallback(() => {
    setRecentFiles([]);
  }, []);

  const removeRecent = useCallback((path: string) => {
    setRecentFiles((prev) => prev.filter((e) => e.path !== path));
  }, []);

  return { recentFiles, trackFile, clearRecent, removeRecent };
}
