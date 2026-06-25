// useFileBrowser — manages file tree state: current path, selected file, search.
// Data + functions paradigm.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type FileContent,
  type FileEntry,
  type ContentSearchResult,
  browseFiles,
  readFile,
  searchFiles,
  searchFileContent,
} from "../services/files";

const POLL_INTERVAL_MS = 5_000;

export type FileBrowserState = {
  files: FileEntry[];
  currentPath: string;
  selectedFile: FileContent | null;
  searchQuery: string;
  searchResults: FileEntry[];
  contentSearchResults: ContentSearchResult[];
  isContentSearch: boolean;
  navigateTo: (path: string) => void;
  selectFile: (path: string) => void;
  setSearchQuery: (query: string) => void;
  isLoading: boolean;
  /** Paths whose `modified` timestamp changed since last poll. */
  changedPaths: Set<string>;
  /** Epoch ms of last successful poll. */
  lastRefreshTime: number | null;
};

export function useFileBrowser(): FileBrowserState {
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const prevModifiedRef = useRef<Map<string, string>>(new Map());
  const [changedPaths, setChangedPaths] = useState<Set<string>>(new Set());
  const [lastRefreshTime, setLastRefreshTime] = useState<number | null>(null);

  // Fetch file list for current path — poll every 5s when idle
  const { data: browseResult, isLoading } = useQuery({
    queryKey: ["files", currentPath],
    queryFn: () => browseFiles(currentPath),
    enabled: !searchQuery,
    refetchInterval: POLL_INTERVAL_MS,
  });

  const files = browseResult?.entries ?? [];

  // Detect changed files by comparing modification timestamps
  useEffect(() => {
    if (files.length === 0) {
      prevModifiedRef.current.clear();
      setChangedPaths(new Set());
      return;
    }

    const currentMap = new Map<string, string>();
    const changed = new Set<string>();

    for (const f of files) {
      currentMap.set(f.path, f.modified ?? "");
      const prev = prevModifiedRef.current.get(f.path);
      if (prev !== undefined && prev !== f.modified) {
        changed.add(f.path);
      }
    }

    // Detect removed files
    for (const [path] of prevModifiedRef.current) {
      if (!currentMap.has(path)) {
        changed.add(path);
      }
    }

    prevModifiedRef.current = currentMap;
    setChangedPaths(changed);
    setLastRefreshTime(Date.now());

    // Clear indicator after 8 seconds
    if (changed.size > 0) {
      const timer = setTimeout(() => setChangedPaths(new Set()), 8_000);
      return () => clearTimeout(timer);
    }
  }, [files]);

  // Detect @ prefix for content search
  const isContentSearch = searchQuery.startsWith("@");
  const nameQuery = isContentSearch ? "" : searchQuery;
  const contentQuery = isContentSearch ? searchQuery.slice(1) : "";

  // Search files by name when query is present (not @-prefixed)
  const { data: searchResults = [] } = useQuery<FileEntry[]>({
    queryKey: ["file-search", nameQuery],
    queryFn: () => searchFiles(nameQuery),
    enabled: nameQuery.length >= 2,
  });

  // Search file contents when @-prefixed query is present
  const { data: contentSearchResults = [] } = useQuery<ContentSearchResult[]>({
    queryKey: ["file-content-search", contentQuery],
    queryFn: () => searchFileContent(contentQuery),
    enabled: isContentSearch && contentQuery.length >= 2,
  });

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    setSelectedFile(null);
    setSearchQuery("");
  }, []);

  const selectFile = useCallback((path: string) => {
    // Load file content
    readFile(path).then(setSelectedFile).catch(console.error);
  }, []);

  return {
    files,
    currentPath,
    selectedFile,
    searchQuery,
    searchResults,
    contentSearchResults,
    isContentSearch,
    navigateTo,
    selectFile,
    setSearchQuery,
    isLoading,
    changedPaths,
    lastRefreshTime,
  };
}
