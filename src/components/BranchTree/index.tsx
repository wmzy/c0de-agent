// BranchTree — session branch visualization with fork support.
// Spec §10.4: display session branch tree, support forking from any message.
//
// Data + functions: pure render + callback props.
// Optimized: tree connector lines, message preview, relative time from updatedAt,
// active highlight with left border, smooth transitions.

import { css } from "@linaria/core";
import { Button, Empty, ScrollArea } from "haze-ui";
import { useCallback, useMemo } from "react";
import type { SessionData } from "../../services/session";
import type { SessionPreview } from "../../hooks/useSessionPreviews";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
`;

const treeArea = css`
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
`;

const nodeRow = css`
  display: flex;
  align-items: flex-start;
  gap: 0;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--haze-color-text);
  transition: background 0.15s ease, border-color 0.15s ease;
  border-left: 3px solid transparent;
  margin: 1px 0;
  position: relative;

  &:hover {
    background: var(--haze-color-bg-subtle);
  }
`;

const nodeActive = css`
  background: var(--haze-color-primary-subtle);
  border-left-color: var(--haze-color-primary);
  color: var(--haze-color-text);
`;

const nodeIcon = css`
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
`;

const nodeContent = css`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const nodeTitleRow = css`
  display: flex;
  align-items: center;
  gap: 6px;
`;

const nodeTitle = css`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
`;

const nodeActiveTitle = css`
  font-weight: 600;
  color: var(--haze-color-primary);
`;

const nodeMeta = css`
  font-size: 11px;
  color: var(--haze-color-text-muted);
  flex-shrink: 0;
  white-space: nowrap;
`;

const nodePreview = css`
  font-size: 11px;
  color: var(--haze-color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
  opacity: 0.8;
`;

const nodeActions = css`
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s ease;
  margin-left: 4px;

  ${nodeRow}:hover & {
    opacity: 1;
  }
`;

const treeConnector = css`
  display: flex;
  align-items: stretch;
`;

const treeLine = css`
  width: 24px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
`;

const treeLineVertical = css`
  position: absolute;
  top: 0;
  bottom: 0;
  left: 11px;
  width: 2px;
  background: var(--haze-color-border);
`;

const treeLineHorizontal = css`
  position: absolute;
  top: 18px;
  left: 11px;
  width: 12px;
  height: 2px;
  background: var(--haze-color-border);
`;

const branchDot = css`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--haze-color-primary);
  flex-shrink: 0;
  position: relative;
  z-index: 1;
  margin-top: 14px;
  margin-left: 8px;
  box-shadow: 0 0 0 2px var(--haze-color-bg);
`;

const leafDot = css`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--haze-color-text-muted);
  flex-shrink: 0;
  position: relative;
  z-index: 1;
  margin-top: 15px;
  margin-left: 9px;
  opacity: 0.5;
`;

const rootIcon = css`
  color: var(--haze-color-text-secondary);
  font-size: 14px;
  margin-top: 13px;
  margin-left: 7px;
`;

// ---------------------------------------------------------------------------
// Tree building — convert flat session list into a tree structure
// ---------------------------------------------------------------------------

type TreeNode = {
  session: SessionData;
  children: TreeNode[];
  depth: number;
  isFork: boolean;
};

function buildTree(sessions: SessionData[]): TreeNode[] {
  const byParent = new Map<string | null | undefined, SessionData[]>();
  for (const s of sessions) {
    const key = s.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(s);
    byParent.set(key, list);
  }

  function buildChildren(parentId: string | null, depth: number): TreeNode[] {
    const children = byParent.get(parentId) ?? [];
    children.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return children.map((session) => ({
      session,
      children: buildChildren(session.id, depth + 1),
      depth,
      isFork: !!session.parentId,
    }));
  }

  return buildChildren(null, 0);
}

// ---------------------------------------------------------------------------
// Format relative time
// ---------------------------------------------------------------------------

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天前`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}周前`;
  const months = Math.floor(days / 30);
  return `${months}月前`;
}

// ---------------------------------------------------------------------------
// Tree node icon (SVG) — replaces emoji for consistent rendering
// ---------------------------------------------------------------------------

function NodeIcon({ hasChildren, isFork }: { hasChildren: boolean; isFork: boolean }) {
  if (hasChildren) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ color: "var(--haze-color-primary)" }}>
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12l3 3 5-5" />
      </svg>
    );
  }
  if (isFork) {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ color: "var(--haze-color-text-muted)", opacity: 0.6 }}>
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ color: "var(--haze-color-text-muted)" }}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// TreeNode component
// ---------------------------------------------------------------------------

type TreeNodeProps = {
  node: TreeNode;
  activeSessionId: string | null;
  preview: SessionPreview | null;
  onSelect: (id: string) => void;
  onFork: (sessionId: string, branchPoint: number) => void;
  isLast?: boolean;
};

function TreeNodeRow({ node, activeSessionId, preview, onSelect, onFork, isLast = false }: TreeNodeProps) {
  const isActive = node.session.id === activeSessionId;
  const branchPoint = node.session.branchPoint ?? 0;

  const handleFork = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onFork(node.session.id, branchPoint);
    },
    [node.session.id, branchPoint, onFork],
  );

  const relativeTime = formatRelativeTime(node.session.updatedAt instanceof Date ? node.session.updatedAt.toISOString() : String(node.session.updatedAt));

  return (
    <div>
      <div
        className={`${nodeRow} ${isActive ? nodeActive : ""}`}
        onClick={() => onSelect(node.session.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onSelect(node.session.id);
        }}
      >
        {node.depth > 0 && (
          <div className={treeConnector}>
            <div className={treeLine}>
              <div className={treeLineHorizontal} />
            </div>
          </div>
        )}
        <span className={node.depth > 0 ? branchDot : node.isFork ? branchDot : rootIcon}>
          <NodeIcon hasChildren={node.children.length > 0} isFork={node.isFork} />
        </span>
        <div className={nodeContent}>
          <div className={nodeTitleRow}>
            <span className={`${nodeTitle} ${isActive ? nodeActiveTitle : ""}`}>
              {node.session.title || "未命名会话"}
            </span>
            <span className={nodeMeta}>{relativeTime}</span>
          </div>
          {preview && (
            <span className={nodePreview}>{preview.lastMessage || "暂无消息"}</span>
          )}
        </div>
        <div className={nodeActions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleFork}
            title="从此处分叉"
            style={{ padding: "2px 6px", fontSize: 11 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M6 21V9a9 9 0 0 0 9 9" />
            </svg>
          </Button>
        </div>
      </div>
      {node.children.map((child, idx) => (
        <TreeNodeRow
          key={child.session.id}
          node={child}
          activeSessionId={activeSessionId}
          preview={null}
          onSelect={onSelect}
          onFork={onFork}
          isLast={idx === node.children.length - 1}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export type BranchTreeProps = {
  sessions: SessionData[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onFork: (sessionId: string, messageIndex: number) => void;
  previews?: Record<string, SessionPreview>;
  className?: string;
};

export function BranchTree({
  sessions,
  activeSessionId,
  onSelectSession,
  onFork,
  previews,
  className,
}: BranchTreeProps) {
  const tree = useMemo(() => buildTree(sessions), [sessions]);

  return (
    <div className={`${container} ${className ?? ""}`}>
      <div className={header}>
        <span>会话分支</span>
        <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>
          {sessions.length} 个会话
        </span>
      </div>
      <ScrollArea>
        <div className={treeArea}>
          {tree.length === 0 ? (
            <div style={{ padding: "24px 12px" }}>
              <Empty description="暂无会话" />
            </div>
          ) : (
            tree.map((node) => (
              <TreeNodeRow
                key={node.session.id}
                node={node}
                activeSessionId={activeSessionId}
                preview={previews?.[node.session.id] ?? null}
                onSelect={onSelectSession}
                onFork={onFork}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
