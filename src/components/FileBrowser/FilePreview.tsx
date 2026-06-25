// FilePreview — renders file content with syntax-aware display.
// Spec §10.4: special rendering for images, markdown, JSON, code.
//
// Data + functions paradigm.

import { css } from "@linaria/core";
import { Button, CodeBlock, Spinner } from "haze-ui";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import { renderMarkdown } from "../../utils/markdown";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileContent } from "../../services/files";
import { CodeEditor } from "../CodeEditor"

const previewContainer = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const previewHeader = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`;

const previewPath = css`
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: monospace;
`;

const previewBody = css`
  flex: 1;
  overflow: auto;
  padding: 0;
`;

const imagePreview = css`
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  margin: auto;
  padding: 16px;
`;

const textPreview = css`
  font-family: var(--haze-font-mono, monospace);
  font-size: 13px;
  line-height: 1.6;
  padding: 16px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--haze-color-text);
`;

const loadingCenter = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
`;

const jsonPreview = css`
  font-family: var(--haze-font-mono, monospace);
  font-size: 13px;
  line-height: 1.5;
  padding: 16px;
`;

const jsonKey = css`
  color: #7c3aed;
`;

const jsonString = css`
  color: #16a34a;
`;

const jsonNumber = css`
  color: #2563eb;
`;

const jsonBoolean = css`
  color: #d97706;
`;

const jsonNull = css`
  color: #9ca3af;
`;

const jsonFoldToggle = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-right: 2px;
  cursor: pointer;
  user-select: none;
  font-size: 9px;
  line-height: 1;
  border-radius: 2px;
  color: var(--haze-color-text-secondary, #888);
  background: transparent;
  border: none;
  padding: 0;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s;

  &:hover {
    color: var(--haze-color-text, #fff);
    background: var(--haze-color-bg-hover, rgba(255, 255, 255, 0.08));
  }
`;

const jsonCollapsedPreview = css`
  color: var(--haze-color-text-muted, #999);
  font-size: 12px;
  margin: 0 4px;
`;

const jsonToolbar = css`
  display: flex;
  gap: 8px;
  padding: 6px 16px;
  font-size: 12px;
  border-bottom: 1px solid var(--haze-color-border);
  color: var(--haze-color-text-secondary);
  align-items: center;
`;

const jsonToolbarBtn = css`
  font-size: 12px;
  color: var(--haze-color-text-secondary, #888);
  background: none;
  border: 1px solid var(--haze-color-border, #333);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;

  &:hover {
    color: var(--haze-color-text, #fff);
    border-color: var(--haze-color-text-secondary, #888);
  }
`;

const jsonIndent = css`
  padding-left: 20px;
`;

const pdfPreview = css`
  width: 100%;
  height: 100%;
  border: none;
`;

const audioPreview = css`
  width: 100%;
  padding: 32px 16px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  color: var(--haze-color-text-secondary);
  font-size: 13px;

  audio {
    width: 100%;
    max-width: 600px;
  }
`;

const videoPreview = css`
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;

  video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
`;

const mermaidContainer = css`
  padding: 16px;
  overflow-x: auto;

  svg {
    max-width: 100%;
    height: auto;
  }
`;

const mermaidError = css`
  font-family: var(--haze-font-mono, monospace);
  font-size: 12px;
  padding: 12px 16px;
  margin: 16px;
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
`;

const markdownContainer = css`
  padding: 20px 24px;
  line-height: 1.7;
  color: var(--haze-color-text, #e2e8f0);
  font-family: var(--haze-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 14px;

  /* Headings */
  h1, h2, h3, h4, h5, h6 {
    margin-top: 1.4em;
    margin-bottom: 0.6em;
    font-weight: 600;
    line-height: 1.3;
    color: var(--haze-color-text, #f1f5f9);
  }
  h1 { font-size: 1.75em; border-bottom: 1px solid var(--haze-color-border, #334155); padding-bottom: 0.3em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid var(--haze-color-border, #334155); padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1.1em; }
  h5 { font-size: 1em; }
  h6 { font-size: 0.9em; color: var(--haze-color-text-secondary, #94a3b8); }

  /* Paragraphs */
  p {
    margin: 0.8em 0;
  }

  /* Links */
  a {
    color: #60a5fa;
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }

  /* Strong / Emphasis */
  strong { font-weight: 700; }
  em { font-style: italic; }

  /* Lists */
  ul, ol {
    margin: 0.6em 0;
    padding-left: 1.8em;
  }
  li {
    margin: 0.25em 0;
  }
  li > ul, li > ol {
    margin: 0.15em 0;
  }

  /* Blockquotes */
  blockquote {
    margin: 0.8em 0;
    padding: 0.5em 1em;
    border-left: 3px solid #60a5fa;
    background: rgba(96, 165, 250, 0.06);
    color: var(--haze-color-text-secondary, #94a3b8);
  }
  blockquote p {
    margin: 0.3em 0;
  }

  /* Inline code */
  code:not(pre code) {
    font-family: var(--haze-font-mono, monospace);
    font-size: 0.9em;
    padding: 0.15em 0.4em;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    color: #f0abfc;
  }

  /* Fallback code blocks (marked renders these when not intercepted) */
  pre {
    margin: 0.8em 0;
    padding: 0;
    overflow-x: auto;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.3);
  }
  pre code {
    display: block;
    font-family: var(--haze-font-mono, monospace);
    font-size: 13px;
    line-height: 1.55;
    padding: 12px 16px;
    overflow-x: auto;
  }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.8em 0;
    font-size: 13px;
  }
  th, td {
    padding: 6px 12px;
    border: 1px solid var(--haze-color-border, #334155);
    text-align: left;
  }
  th {
    font-weight: 600;
    background: rgba(255, 255, 255, 0.04);
    white-space: nowrap;
  }
  tr:nth-child(even) {
    background: rgba(255, 255, 255, 0.02);
  }

  /* Horizontal rules */
  hr {
    margin: 1.5em 0;
    border: none;
    border-top: 1px solid var(--haze-color-border, #334155);
  }

  /* Images */
  img {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 0.5em 0;
  }

  /* Task lists (GitHub-style) */
  input[type="checkbox"] {
    margin-right: 0.4em;
  }

  /* Wrapped code blocks from CodeBlock component */
  & > .md-code-block {
    margin: 0.8em 0;
    border-radius: 6px;
    overflow: hidden;
  }

  /* Wrapped mermaid diagrams */
  & > .md-mermaid {
    margin: 0.8em 0;
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    sql: "sql",
  };
  return map[ext] ?? "text";
}

function isImageFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"].includes(ext);
}

function isPdfFile(path: string): boolean {
  return path.split(".").pop()?.toLowerCase() === "pdf";
}

function isAudioFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["mp3", "wav", "ogg", "m4a"].includes(ext);
}

function isVideoFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["mp4", "webm", "mov"].includes(ext);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Text-based files that can be edited inline. */
function isEditableFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return [
    "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "json", "jsonl",
    "css", "scss", "less",
    "html", "htm", "svg",
    "md", "mdx", "txt",
    "py", "pyi",
    "rs",
    "go",
    "java",
    "c", "cpp", "h", "hpp",
    "rb",
    "sh", "bash", "zsh",
    "yaml", "yml", "toml",
    "sql",
    "env", "gitignore", "editorconfig",
    "lock",
    "xml",
  ].includes(ext);
}

const editToggleBtn = css`
  margin-left: auto;
`;

// ---------------------------------------------------------------------------
// JSON folding tree
// ---------------------------------------------------------------------------

type JsonTreeNode = {
  key: string | null;
  jsonPath: string;
  value: unknown;
  depth: number;
};

function isContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function getChildEntries(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) {
    return value.map((v, i) => [String(i), v]);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>);
  }
  return [];
}

function collectAllFoldPaths(value: unknown, basePath: string): string[] {
  if (!isContainer(value)) return [];
  const paths = [basePath];
  for (const [k, v] of getChildEntries(value)) {
    const childPath = Array.isArray(value) ? `${basePath}[${k}]` : `${basePath}.${k}`;
    paths.push(...collectAllFoldPaths(v, childPath));
  }
  return paths;
}

function buildJsonTree(
  value: unknown,
  key: string | null,
  parentPath: string,
  depth: number,
): JsonTreeNode {
  const jsonPath = key !== null ? (parentPath ? `${parentPath}.${key}` : key) : parentPath || "$";
  return { key, jsonPath, value, depth };
}

// ---------------------------------------------------------------------------
// JSON foldable sub-components
// ---------------------------------------------------------------------------

function JsonValueLiteral({ value }: { value: unknown }) {
  if (value === null) return <span className={jsonNull}>null</span>;
  const t = typeof value;
  if (t === "string") return <span className={jsonString}>"{String(value)}"</span>;
  if (t === "number") return <span className={jsonNumber}>{String(value)}</span>;
  if (t === "boolean") return <span className={jsonBoolean}>{String(value)}</span>;
  return <span>{String(value)}</span>;
}

function JsonFoldNode({
  node,
  foldedPaths,
  onToggle,
}: {
  node: JsonTreeNode;
  foldedPaths: Set<string>;
  onToggle: (path: string) => void;
}) {
  const { key, jsonPath, value, depth } = node;
  const foldable = isContainer(value);
  const entries = foldable ? getChildEntries(value) : [];
  const isFolded = foldedPaths.has(jsonPath);
  const indent = depth * 20;
  const isArray = Array.isArray(value);
  const openChar = isArray ? "[" : "{";
  const closeChar = isArray ? "]" : "}";

  const keyLabel =
    key !== null && !/^\d+$/.test(key) ? (
      <span className={jsonKey}>&quot;{key}&quot;: </span>
    ) : null;

  if (!foldable) {
    return (
      <div style={{ paddingLeft: indent }}>
        {keyLabel}
        <JsonValueLiteral value={value} />
      </div>
    );
  }

  if (isFolded) {
    return (
      <div style={{ paddingLeft: indent }}>
        <button
          type="button"
          className={jsonFoldToggle}
          onClick={() => onToggle(jsonPath)}
          aria-label="展开"
        >
          ▶
        </button>
        {keyLabel}
        <span>{openChar}</span>
        <span className={jsonCollapsedPreview}>{entries.length} items</span>
        <span>{closeChar}</span>
      </div>
    );
  }

  return (
    <div>
      <div style={{ paddingLeft: indent }}>
        <button
          type="button"
          className={jsonFoldToggle}
          onClick={() => onToggle(jsonPath)}
          aria-label="折叠"
        >
          ▼
        </button>
        {keyLabel}
        <span>{openChar}</span>
      </div>
      {entries.map(([k, v]) => {
        const childPath = Array.isArray(value) ? `${jsonPath}[${k}]` : `${jsonPath}.${k}`;
        return (
          <JsonFoldNode
            key={childPath}
            node={{ key: k, jsonPath: childPath, value: v, depth: depth + 1 }}
            foldedPaths={foldedPaths}
            onToggle={onToggle}
          />
        );
      })}
      <div style={{ paddingLeft: indent }}>{closeChar}</div>
    </div>
  );
}

function JsonFoldable({ raw }: { raw: string }) {
  const [foldedPaths, setFoldedPaths] = useState<Set<string>>(new Set());

  const parsed = useMemo<unknown>(() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, [raw]);

  const allFoldPaths = useMemo(
    () => (parsed !== null && isContainer(parsed) ? collectAllFoldPaths(parsed, "$") : []),
    [parsed],
  );

  const toggle = (path: string) => {
    setFoldedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const foldAll = () => setFoldedPaths(new Set(allFoldPaths));
  const expandAll = () => setFoldedPaths(new Set());

  if (parsed === null) {
    return (
      <pre className={jsonPreview}>
        <CodeBlock language="json">{raw}</CodeBlock>
      </pre>
    );
  }

  const root = buildJsonTree(parsed, null, "$", 0);

  return (
    <div>
      <div className={jsonToolbar}>
        <button type="button" className={jsonToolbarBtn} onClick={foldAll}>
          全部折叠
        </button>
        <button type="button" className={jsonToolbarBtn} onClick={expandAll}>
          全部展开
        </button>
        <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.6 }}>
          {foldedPaths.size > 0 ? `${foldedPaths.size} 折叠` : ""}
        </span>
      </div>
      <pre className={jsonPreview} style={{ margin: 0 }}>
        <JsonFoldNode node={root} foldedPaths={foldedPaths} onToggle={toggle} />
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown with mermaid — parse + render
// ---------------------------------------------------------------------------

type MdSegment =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string }
  | { type: "mermaid"; content: string };

let mermaidIdCounter = 0;

function parseMdSegments(text: string): MdSegment[] {
  const segments: MdSegment[] = [];
  const fence = /```([\w-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    const lang = (match[1] || "").toLowerCase();
    if (lang === "mermaid") {
      segments.push({ type: "mermaid", content: match[2] });
    } else {
      segments.push({ type: "code", lang, content: match[2] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments;
}

function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-diagram-${++mermaidIdCounter}`);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const { svg } = await mermaid.render(idRef.current, code);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className={mermaidError}>
        <div style={{ marginBottom: 4, fontWeight: 600 }}>Mermaid rendering failed</div>
        {error}
      </div>
    );
  }

  return <div ref={containerRef} className={mermaidContainer} />;
}

// Lazy-init mermaid once.
let mermaidReady = false;
function ensureMermaid() {
  if (!mermaidReady) {
    mermaid.initialize({ startOnLoad: false, theme: "default" });
    mermaidReady = true;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type FilePreviewProps = {
  path: string;
  content: FileContent | null;
  isLoading: boolean;
  onClose?: () => void;
};

export function FilePreview({ path, content, isLoading, onClose }: FilePreviewProps) {
  const fileName = path.split("/").pop() ?? path;
  const language = getLanguage(path);
  const isImage = isImageFile(path);
  const isPdf = isPdfFile(path);
  const isAudio = isAudioFile(path);
  const isVideo = isVideoFile(path);
  const canEdit = isEditableFile(path) && !isImage && !isPdf && !isAudio && !isVideo;

  const [editMode, setEditMode] = useState(false);

  const handleSaveComplete = useCallback(() => {
    setEditMode(false);
  }, []);

  const renderedContent = useMemo(() => {
    if (!content) return null;

    if (isPdf) {
      return (
        <iframe
          className={pdfPreview}
          src={`/api/files/${encodeURIComponent(path)}/raw`}
          title={fileName}
        />
      );
    }

    if (isImage) {
      return (
        <img
          className={imagePreview}
          src={`/api/files/${encodeURIComponent(path)}/raw`}
          alt={fileName}
        />
      );
    }

    if (isAudio) {
      return (
        <div className={audioPreview}>
          <audio controls preload="metadata" src={`/api/files/${encodeURIComponent(path)}/raw`} />
          <span>{fileName}</span>
        </div>
      );
    }

    if (isVideo) {
      return (
        <div className={videoPreview}>
          <video controls preload="metadata" src={`/api/files/${encodeURIComponent(path)}/raw`} />
        </div>
      );
    }

    if (language === "json") {
      return <JsonFoldable raw={content.content} />;
    }

    if (language === "markdown") {
      ensureMermaid();
      const segments = parseMdSegments(content.content);
      return (
        <div className={markdownContainer}>
          {segments.map((seg, idx) => {
            if (seg.type === "mermaid") {
              return (
                <div key={idx} className="md-mermaid">
                  <MermaidDiagram code={seg.content} />
                </div>
              );
            }
            if (seg.type === "code") {
              return (
                <div key={idx} className="md-code-block">
                  <CodeBlock language={seg.lang}>{seg.content}</CodeBlock>
                </div>
              );
            }
            // Render markdown text segment via shared renderer.
            return <div key={idx} dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }} />;
          })}
        </div>
      );
    }

    return (
      <div className={textPreview}>
        <CodeBlock language={language}>{content.content}</CodeBlock>
      </div>
    );
  }, [content, isImage, isPdf, isAudio, isVideo, path, fileName, language]);

  if (isLoading) {
    return (
      <div className={previewContainer}>
        <div className={loadingCenter}>
          <Spinner />
        </div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className={previewContainer}>
        <div className={loadingCenter} style={{ color: "var(--haze-color-text-muted)" }}>
          选择文件以预览
        </div>
      </div>
    );
  }

  return (
    <div className={previewContainer}>
      <div className={previewHeader}>
        <span className={previewPath}>{path}</span>
        <span>{formatSize(content.size)}</span>
        <span>{language}</span>
        {canEdit && (
          <Button
            className={editToggleBtn}
            variant={editMode ? "solid" : "ghost"}
            size="sm"
            onClick={() => setEditMode((prev) => !prev)}
          >
            {editMode ? "Preview" : "Edit"}
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        )}
      </div>
      <div className={previewBody}>
        {editMode ? (
          <CodeEditor path={path} onSave={handleSaveComplete} />
        ) : (
          renderedContent
        )}
      </div>
    </div>
  );
}
