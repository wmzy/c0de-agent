// CodeEditor — inline code editor with line numbers and save support.
// Spec §10.4: online editing for code files.
//
// Data + functions: textarea-based, no heavy deps (Monaco/CodeMirror).
// Read-only mode, line gutter, CSS class hooks for syntax highlighting.

import { css, cx } from "@linaria/core";
import { Button, Spinner } from "haze-ui";
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { readFile, writeFile } from "../../services/files";

// ---------------------------------------------------------------------------
// Styles (@linaria — zero runtime)
// ---------------------------------------------------------------------------

const wrapper = css`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", monospace;
  background: var(--haze-color-bg, #0d1117);
  color: var(--haze-color-text, #e6edf3);
`;

const toolbar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--haze-color-border, #30363d);
  background: var(--haze-color-surface, #161b22);
  min-height: 40px;
`;

const toolbarPath = css`
  flex: 1;
  font-size: 13px;
  color: var(--haze-color-text-secondary, #8b949e);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const toolbarStatus = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary, #8b949e);
  white-space: nowrap;
`;

const editorBody = css`
  display: flex;
  flex: 1;
  overflow: hidden;
  position: relative;
`;

const lineGutter = css`
  flex-shrink: 0;
  width: 48px;
  padding: 12px 8px 12px 0;
  text-align: right;
  font-size: 13px;
  line-height: 1.6;
  color: var(--haze-color-text-tertiary, #484f58);
  background: var(--haze-color-surface, #161b22);
  border-right: 1px solid var(--haze-color-border, #30363d);
  user-select: none;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
`;

const textarea = css`
  flex: 1;
  padding: 12px;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  tab-size: 2;
  background: var(--haze-color-bg, #0d1117);
  color: var(--haze-color-text, #e6edf3);
  white-space: pre;
  overflow: auto;
  min-height: 0;
`;

const textareaReadonly = css`
  cursor: default;
  opacity: 0.85;
`;

const loadingOverlay = css`
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
`;

const errorText = css`
  padding: 12px;
  color: #f85149;
  font-size: 13px;
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CodeEditorProps = {
  /** Relative file path (from working dir root). */
  path: string;
  /** If true, editing is disabled. */
  readOnly?: boolean;
  /** Called after a successful save. */
  onSave?: (result: { path: string; size: number; modified: string }) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count lines in a string. */
function lineCount(text: string): number {
  if (text.length === 0) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

/** Generate line number elements separated by newlines. */
function renderLineNumbers(count: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= count; i++) {
    parts.push(String(i));
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CodeEditor({ path, readOnly = false, onSave }: CodeEditorProps) {
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Load file content on mount / path change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    readFile(path)
      .then((file) => {
        if (cancelled) return;
        setContent(file.content);
        setOriginalContent(file.content);
        setDirty(false);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load file");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  // Sync scroll between textarea and gutter.
  const handleScroll = useCallback(() => {
    const ta = textareaRef.current;
    const gutter = gutterRef.current;
    if (ta && gutter) {
      gutter.scrollTop = ta.scrollTop;
    }
  }, []);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setContent(next);
      setDirty(next !== originalContent);
    },
    [originalContent],
  );

  // Handle Tab key for indentation.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (readOnly) return;
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = textareaRef.current;
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const next = `${content.substring(0, start)}  ${content.substring(end)}`;
        setContent(next);
        setDirty(next !== originalContent);
        // Restore cursor after React re-renders.
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      }
    },
    [content, originalContent, readOnly],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await writeFile(path, content);
      setOriginalContent(content);
      setDirty(false);
      onSave?.({ path, size: content.length, modified: new Date().toISOString() });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save file");
    } finally {
      setSaving(false);
    }
  }, [path, content, onSave]);

  // Keyboard shortcut: Ctrl/Cmd+S to save.
  useEffect(() => {
    if (readOnly) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    globalThis.addEventListener("keydown", handler);
    return () => globalThis.removeEventListener("keydown", handler);
  }, [handleSave, readOnly]);

  const lines = lineCount(content);
  const fileName = path.split("/").pop() ?? path;

  if (loading) {
    return (
      <div className={wrapper}>
        <div className={loadingOverlay}>
          <Spinner />
        </div>
      </div>
    );
  }

  if (error && !content) {
    return (
      <div className={wrapper}>
        <div className={errorText}>{error}</div>
      </div>
    );
  }

  return (
    <div className={wrapper}>
      {/* Toolbar */}
      <div className={toolbar}>
        <span className={toolbarPath}>{fileName}</span>
        {dirty && <span className={toolbarStatus}>modified</span>}
        {error && (
          <span className={toolbarStatus} style={{ color: "#f85149" }}>
            {error}
          </span>
        )}
        {!readOnly && (
          <Button
            size="sm"
            variant={dirty ? "solid" : "ghost"}
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? <Spinner size="sm" /> : "Save"}
          </Button>
        )}
      </div>

      {/* Editor body */}
      <div className={editorBody}>
        <div ref={gutterRef} className={lineGutter}>
          {renderLineNumbers(lines)}
        </div>
        <textarea
          ref={textareaRef}
          className={cx(textarea, readOnly && textareaReadonly)}
          value={content}
          readOnly={readOnly}
          spellCheck={false}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          aria-label={`Edit ${fileName}`}
        />
      </div>
    </div>
  );
}
