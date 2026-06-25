// FileBrowser — tree directory browser with search, git status, preview.
// Spec §10.4: tree structure, expand/collapse, search, git status markers.
//
// Data + functions: state lives in useFileBrowser hook; this component renders it.
// Optimized: SVG file icons, search query highlighting, reference-in-chat.

import { css } from "@linaria/core";
import { Button, Empty, Input, ScrollArea, Spinner } from "haze-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFileBrowser } from "../../hooks/useFileBrowser";
import { useRecentFiles, type RecentFile } from "../../hooks/useRecentFiles";
import type { FileEntry, ContentSearchResult } from "../../services/files";
import { FilePreview } from "./FilePreview";

// ---------------------------------------------------------------------------
// Styles (@linaria — zero runtime)
// ---------------------------------------------------------------------------

const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
`;

const header = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--haze-color-border);
`;

const breadcrumb = css`
  font-size: 13px;
  color: var(--haze-color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
`;

const searchBox = css`
  padding: 8px 12px;
  border-bottom: 1px solid var(--haze-color-border);
`;

const treeArea = css`
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
`;

const entry = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--haze-color-text);
  border-radius: 4px;
  margin: 0 4px;
  user-select: none;
  transition: background 0.12s ease;

  &:hover {
    background: var(--haze-color-bg-subtle);
  }
`;

const entrySelected = css`
  background: var(--haze-color-primary-subtle);
  color: var(--haze-color-primary);
`;

const entryIcon = css`
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const entryName = css`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const searchHighlight = css`
  background: rgba(255, 213, 0, 0.25);
  color: var(--haze-color-text);
  border-radius: 2px;
  padding: 0 1px;
`;

const gitBadge = css`
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  font-weight: 600;
  flex-shrink: 0;
`;

const gitAdded = css`
  background: color-mix(in srgb, #16a34a 15%, var(--haze-color-bg));
  color: #4ade80;
`;

const gitModified = css`
  background: color-mix(in srgb, #ca8a04 15%, var(--haze-color-bg));
  color: #facc15;
`;

const gitDeleted = css`
  background: color-mix(in srgb, #dc2626 15%, var(--haze-color-bg));
  color: #f87171;
`;

const gitUntracked = css`
  background: color-mix(in srgb, #4f46e5 15%, var(--haze-color-bg));
  color: #818cf8;
`;

const previewPane = css`
  flex: 1;
  overflow: hidden;
  border-left: 1px solid var(--haze-color-border);
  min-width: 0;
`;

const splitView = css`
  display: flex;
  height: 100%;
  min-width: 0;
`;

const treePane = css`
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--haze-color-border);
  overflow: hidden;

  @media (max-width: 768px) {
    width: 100%;
    border-right: none;
  }
`;

const mobileHidden = css`
  @media (max-width: 768px) {
    display: none;
  }
`;

const refButton = css`
  opacity: 0;
  transition: opacity 0.12s ease;
  flex-shrink: 0;
  padding: 1px 4px !important;
  font-size: 10px !important;

  ${entry}:hover & {
    opacity: 1;
  }
`;

const changeIndicator = css`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #facc15;
  flex-shrink: 0;
  animation: change-pulse 1.5s ease-in-out 3;

  @keyframes change-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.4); }
  }
`;

const refreshBanner = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--haze-color-text-secondary);
  background: color-mix(in srgb, #facc15 8%, var(--haze-color-bg));
  border-bottom: 1px solid var(--haze-color-border);
  animation: banner-slide-in 0.2s ease-out;

  @keyframes banner-slide-in {
    from { opacity: 0; transform: translateY(-100%); }
    to { opacity: 1; transform: translateY(0); }
  }
`;

const refreshDot = css`
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #facc15;
  flex-shrink: 0;
`;

const recentSection = css`
  padding: 0 4px;
`;

const recentHeader = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--haze-color-text-muted);
`;

const recentClear = css`
  font-size: 10px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--haze-color-text-muted);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.12s ease;
  background: none;
  border: none;
  padding: 0;

  &:hover {
    opacity: 1;
    color: var(--haze-color-danger, #f87171);
  }
`;

const recentItem = css`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--haze-color-text);
  border-radius: 4px;
  margin: 0 4px;
  user-select: none;
  transition: background 0.12s ease;

  &:hover {
    background: var(--haze-color-bg-subtle);
  }
`;

const recentItemName = css`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const recentItemPath = css`
  font-size: 11px;
  color: var(--haze-color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
`;

const recentItemRemove = css`
  opacity: 0;
  flex-shrink: 0;
  padding: 1px 4px !important;
  font-size: 10px !important;
  color: var(--haze-color-text-muted);
  background: none;
  border: none;
  cursor: pointer;
  transition: opacity 0.12s ease, color 0.12s ease;

  &:hover {
    color: var(--haze-color-danger, #f87171);
  }

  ${recentItem}:hover & {
    opacity: 1;
  }
`;

const contentMatch = css`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 12px;
  cursor: pointer;
  border-radius: 4px;
  margin: 0 4px;
  user-select: none;
  transition: background 0.12s ease;

  &:hover {
    background: var(--haze-color-bg-subtle);
  }
`;

const contentMatchFile = css`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--haze-color-text);
`;

const contentMatchLine = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary);
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 22px;
`;

const contentMatchLineNum = css`
  color: var(--haze-color-text-muted);
  margin-right: 6px;
`;

const searchHint = css`
  padding: 6px 12px;
  font-size: 11px;
  color: var(--haze-color-text-muted);
  border-bottom: 1px solid var(--haze-color-border);
`;

// ---------------------------------------------------------------------------
// Git status badge
// ---------------------------------------------------------------------------

function GitBadge({ status }: { status?: string }) {
  if (!status) return null;
  const cls =
    status === "added"
      ? gitAdded
      : status === "modified"
        ? gitModified
        : status === "deleted"
          ? gitDeleted
          : gitUntracked;
  const label =
    status === "added" ? "A" : status === "modified" ? "M" : status === "deleted" ? "D" : "?";
  return <span className={`${gitBadge} ${cls}`}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Search highlight — wraps matching substring in highlighted span
// ---------------------------------------------------------------------------

function HighlightedName({ name, query }: { name: string; query: string }) {
  if (!query || query.length < 2) {
    return <span>{name}</span>;
  }
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) {
    return <span>{name}</span>;
  }
  return (
    <span>
      {name.slice(0, idx)}
      <span className={searchHighlight}>{name.slice(idx, idx + query.length)}</span>
      {name.slice(idx + query.length)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SVG File Icons — consistent colored icons by file type
// ---------------------------------------------------------------------------

type IconColor = { fill: string; stroke: string };

const ICON_COLORS: Record<string, IconColor> = {
  ts: { fill: "none", stroke: "#3178c6" },
  tsx: { fill: "none", stroke: "#3178c6" },
  js: { fill: "none", stroke: "#f7df1e" },
  jsx: { fill: "none", stroke: "#f7df1e" },
  json: { fill: "none", stroke: "#f59e0b" },
  md: { fill: "none", stroke: "#8b5cf6" },
  css: { fill: "none", stroke: "#06b6d4" },
  scss: { fill: "none", stroke: "#ec4899" },
  html: { fill: "none", stroke: "#f97316" },
  py: { fill: "none", stroke: "#3b82f6" },
  rs: { fill: "none", stroke: "#f97316" },
  go: { fill: "none", stroke: "#06b6d4" },
  svg: { fill: "none", stroke: "#8b5cf6" },
  default: { fill: "none", stroke: "var(--haze-color-text-muted)" },
};

function getIconColor(name: string): IconColor {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ICON_COLORS[ext] ?? ICON_COLORS.default;
}

function FileIcon({ name, isDir, isExpanded }: { name: string; isDir: boolean; isExpanded: boolean }) {
  if (isDir) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--haze-color-primary)"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {isExpanded ? (
          <>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <path d="M9.5 14l3 0" />
          </>
        ) : (
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        )}
      </svg>
    );
  }

  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const { stroke } = getIconColor(name);

  // Special icons for common types
  if (ext === "json") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={stroke}
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
        <path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1" />
      </svg>
    );
  }
  if (ext === "md") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={stroke}
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3h18v18H3z" />
        <path d="M7 15V9l2.5 2.5L12 9v6" />
        <path d="M17 12v3m0 0v-3m0 3h-2m2 0h2" />
      </svg>
    );
  }
  if (ext === "css" || ext === "scss") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={stroke}
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 2l2 18 6 2 6-2 2-18H4z" />
        <path d="M8 8h8l-1 6-3 1-3-1-.5-3h2" />
      </svg>
    );
  }
  if (ext === "html") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={stroke}
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
        <line x1="14" y1="4" x2="10" y2="20" />
      </svg>
    );
  }
  if (ext === "py") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={stroke}
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2c-4 0-6 2-6 4v2h6v1H6c-2 0-4 2-4 5s2 4 4 4h2v-2c0-2 2-3 4-3h5c2 0 3-1 3-3V6c0-2-2-4-5-4h-2z" />
      </svg>
    );
  }
  if (ext === "rs") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={stroke}
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    );
  }
  if (ext === "go") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={stroke}
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 6h20" />
        <path d="M6 18h12" />
        <path d="M12 6c-4 0-6 2.5-6 6s2 6 6 6c3 0 5-1.5 5-4s-2-4-5-4" />
      </svg>
    );
  }
  // Default file icon for ts, tsx, js, jsx, images, etc.
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={stroke}
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// FileEntry component
// ---------------------------------------------------------------------------



type FileEntryItemProps = {
  name: string;
  path: string;
  isDir: boolean;
  gitStatus?: string;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onReference?: (path: string) => void;
  searchQuery?: string;
  isChanged?: boolean;
};

function FileEntryItem({
  name,
  path,
  isDir,
  gitStatus,
  depth,
  isExpanded,
  isSelected,
  onToggle,
  onSelect,
  onReference,
  searchQuery,
  isChanged,
}: FileEntryItemProps) {
  const handleClick = useCallback(() => {
    if (isDir) {
      onToggle();
    } else {
      onSelect();
    }
  }, [isDir, onToggle, onSelect]);

  const handleReference = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onReference?.(path);
    },
    [onReference, path],
  );

  return (
    <div
      className={`${entry} ${isSelected ? entrySelected : ""}`}
      style={{ paddingLeft: 12 + depth * 16 }}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") handleClick();
      }}
    >
      <span className={entryIcon}>
        <FileIcon name={name} isDir={isDir} isExpanded={isExpanded} />
      </span>
      <span className={entryName}>
        <HighlightedName name={name} query={searchQuery ?? ""} />
      </span>
      {isChanged && <span className={changeIndicator} title="文件已变更" />}
      <GitBadge status={gitStatus} />
      {!isDir && onReference && (
        <Button
          variant="ghost"
          size="sm"
          className={refButton}
          onClick={handleReference}
          title="在聊天中引用"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Get parent directory path
// ---------------------------------------------------------------------------

function getParentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// Recent files list
// ---------------------------------------------------------------------------

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function ContentSearchResultItem({
  result,
  query,
  onSelect,
}: {
  result: ContentSearchResult;
  query: string;
  onSelect: (path: string) => void;
}) {
  const lower = result.content.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);

  return (
    <div className={contentMatch} onClick={() => onSelect(result.path)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(result.path); }}>
      <div className={contentMatchFile}>
        <span className={entryIcon}><FileIcon name={result.name} isDir={false} isExpanded={false} /></span>
        <HighlightedName name={result.name} query={query} />
      </div>
      <div className={contentMatchLine}>
        <span className={contentMatchLineNum}>{result.line}:</span>
        {idx >= 0 ? (
          <span>
            {result.content.slice(0, idx)}
            <span className={searchHighlight}>{result.content.slice(idx, idx + query.length)}</span>
            {result.content.slice(idx + query.length)}
          </span>
        ) : result.content}
      </div>
    </div>
  );
}

function RecentFilesList({
  files,
  onOpen,
  onRemove,
  onClear,
}: {
  files: RecentFile[];
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  onClear: () => void;
}) {
  if (files.length === 0) return null;

  return (
    <div className={recentSection}>
      <div className={recentHeader}>
        <span>最近文件</span>
        <button className={recentClear} onClick={onClear} title="清除历史">
          清除
        </button>
      </div>
      {files.map((f) => (
        <div
          key={f.path}
          className={recentItem}
          onClick={() => onOpen(f.path)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onOpen(f.path);
          }}
          title={`${f.path}\n${formatRelativeTime(f.openedAt)}`}
        >
          <span className={entryIcon}>
            <FileIcon name={f.name} isDir={false} isExpanded={false} />
          </span>
          <span className={recentItemName}>{f.name}</span>
          <span className={recentItemPath}>{formatRelativeTime(f.openedAt)}</span>
          <button
            className={recentItemRemove}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(f.path);
            }}
            title="移除"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main FileBrowser component
// ---------------------------------------------------------------------------

export type FileBrowserProps = {
  onFileSelect?: (path: string) => void;
  onReferenceFile?: (path: string) => void;
  className?: string;
};

export function FileBrowser({ className, onFileSelect, onReferenceFile }: FileBrowserProps) {
  const {
    currentPath,
    files,
    selectedFile,
    searchQuery,
    searchResults,
    contentSearchResults,
    isContentSearch,
    isLoading,
    navigateTo,
    selectFile,
    setSearchQuery,
    changedPaths,
    lastRefreshTime,
  } = useFileBrowser();

  const { recentFiles, trackFile, clearRecent, removeRecent } = useRecentFiles();

  const [showRefreshBanner, setShowRefreshBanner] = useState(false);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Show refresh banner briefly when changes are detected
  useEffect(() => {
    if (changedPaths.size > 0) {
      setShowRefreshBanner(true);
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = setTimeout(() => setShowRefreshBanner(false), 6_000);
    }
    return () => clearTimeout(bannerTimerRef.current);
  }, [changedPaths, lastRefreshTime]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [showPreview, setShowPreview] = useState(true);

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const goUp = useCallback(() => {
    const parent = getParentPath(currentPath);
    navigateTo(parent);
  }, [currentPath, navigateTo]);

  const displayEntries = searchQuery.length >= 2 && !isContentSearch ? searchResults : files;

  const handleSelect = useCallback(
    (path: string) => {
      selectFile(path);
      trackFile(path);
      setShowPreview(true);
      onFileSelect?.(path);
    },
    [selectFile, trackFile, onFileSelect],
  );

  const handleToggle = useCallback(
    (path: string) => {
      toggleExpand(path);
      navigateTo(path);
    },
    [toggleExpand, navigateTo],
  );

  return (
    <div className={`${container} ${className ?? ""}`}>
      {showRefreshBanner && changedPaths.size > 0 && (
        <div className={refreshBanner}>
          <span className={refreshDot} />
          {changedPaths.size} 个文件已变更
        </div>
      )}
      <div className={header}>
        {currentPath && (
          <Button variant="ghost" size="sm" onClick={goUp} title="返回上级">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Button>
        )}
        <span className={breadcrumb}>{currentPath || "/"}</span>
      </div>

      <div className={searchBox}>
        <Input
          placeholder="搜索文件… 用 @ 前缀搜索内容"
          value={searchQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
          size="sm"
        />
      </div>

      <div className={splitView}>
        <div className={treePane}>
          <ScrollArea>
            {/* Recent files — show when at root, no search, no file selected */}
            {!currentPath && !searchQuery && !selectedFile && (
              <RecentFilesList
                files={recentFiles}
                onOpen={handleSelect}
                onRemove={removeRecent}
                onClear={clearRecent}
              />
            )}
            <div className={treeArea}>
              {isLoading ? (
                <div style={{ padding: 24, textAlign: "center" }}>
                  <Spinner size="sm" />
                </div>
              ) : isContentSearch ? (
                // Content search results
                contentSearchResults.length === 0 ? (
                  <div style={{ padding: "24px 12px" }}>
                    <Empty description={searchQuery.length >= 3 ? "未找到匹配内容" : "输入至少 2 个字符搜索内容"} />
                  </div>
                ) : (
                  <>
                    <div className={searchHint}>
                      搜索 "@{searchQuery.slice(1)}" 的内容匹配 ({contentSearchResults.length})
                    </div>
                    {contentSearchResults.map((result, idx) => (
                      <ContentSearchResultItem
                        key={`${result.path}:${result.line}:${idx}`}
                        result={result}
                        query={searchQuery.slice(1)}
                        onSelect={handleSelect}
                      />
                    ))}
                  </>
                )
              ) : displayEntries.length === 0 ? (
                <div style={{ padding: "24px 12px" }}>
                  <Empty description={searchQuery ? "未找到文件" : "空目录"} />
                </div>
              ) : (
                displayEntries.map((entry: FileEntry) => (
                  <FileEntryItem
                    key={entry.path}
                    name={entry.name}
                    path={entry.path}
                    isDir={entry.isDir}
                    depth={0}
                    isExpanded={expandedPaths.has(entry.path)}
                    isSelected={selectedFile?.path === entry.path}
                    onToggle={() => handleToggle(entry.path)}
                    onSelect={() => handleSelect(entry.path)}
                    onReference={onReferenceFile}
                    searchQuery={searchQuery}
                    isChanged={changedPaths.has(entry.path)}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {selectedFile && (
          <div className={`${previewPane} ${!showPreview ? mobileHidden : ""}`}>
            <FilePreview
              path={selectedFile.path}
              content={selectedFile}
              isLoading={false}
              onClose={() => setShowPreview(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
