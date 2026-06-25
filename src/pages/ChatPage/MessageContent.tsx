// MessageContent — parses message segments and renders text + code blocks.
// Uses shared renderMarkdown (marked + DOMPurify) for pure markdown.
// CodeBlockView is preserved for syntax-highlighted fenced code blocks.

import { useMemo } from "react";
import { renderMarkdown } from "../../utils/markdown";
import { CodeBlockView } from "./CodeBlock";
import { type Segment, parseSegments } from "./helpers";

// ---------------------------------------------------------------------------
// MessageContent — parses segments and renders text + code blocks
// ---------------------------------------------------------------------------

export function MessageContent({ text, isUser }: { text: string; isUser: boolean }) {
  const segments = useMemo(() => parseSegments(text), [text]);

  // For user messages, render text verbatim (no markdown processing)
  if (isUser) {
    return (
      <div className="c0de-msg-text">
        {segments.length === 0 ? text : segments.map((seg, idx) => {
          if (seg.type === "code") {
            return <CodeBlockView key={idx} code={seg.content} lang={seg.lang} />;
          }
          return <span key={idx}>{seg.content}</span>;
        })}
      </div>
    );
  }

  return (
    <div className="c0de-msg-text">
      {segments.map((seg, idx) => {
        if (seg.type === "code") {
          return <CodeBlockView key={idx} code={seg.content} lang={seg.lang} />;
        }
        return (
          <span
            key={idx}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(seg.content) }}
          />
        );
      })}
    </div>
  );
}
