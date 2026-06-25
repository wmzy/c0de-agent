// CodeBlock — header (lang + copy) + body (line numbers + highlighted code).
// Tokenizer and SyntaxHighlighter live in the shared SyntaxHighlighter module.

import { useCallback, useMemo, useState } from "react";
import { SyntaxHighlighter } from "../../components/SyntaxHighlighter";
import { toast } from "../../utils/toast";

export function CodeBlockView({ code, lang, filePath }: { code: string; lang: string; filePath?: string }) {
  const [copied, setCopied] = useState(false);
  const [refCopied, setRefCopied] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);

  const handleCopy = useCallback(() => {
    const text = lines.join("\n");
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* noop */
          }
          document.body.removeChild(ta);
        });
    }
  }, [lines]);

  const displayLang = lang && lang !== "plain" ? lang : "text";
  const totalLines = lines.length;
  const refPath = filePath ?? "code-block";
  const refText = `@[${refPath}:1-${totalLines}]`;

  const handleCopyRef = useCallback(() => {
    const write = (text: string) => {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
          setRefCopied(true);
          toast.success("引用已复制");
          setTimeout(() => setRefCopied(false), 1500);
        }).catch(() => {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
            setRefCopied(true);
            toast.success("引用已复制");
            setTimeout(() => setRefCopied(false), 1500);
          } catch {
            /* noop */
          }
          document.body.removeChild(ta);
        });
      }
    };
    write(refText);
  }, [refText]);

  return (
    <div className="c0de-cb__wrapper">
      <div className="c0de-cb__header">
        <span className="c0de-cb__lang">{displayLang}</span>
        <div className="c0de-cb__actions">
          <button
            type="button"
            className="c0de-cb__ref"
            data-copied={String(refCopied)}
            onClick={handleCopyRef}
            aria-label="复制引用"
            title={refText}
          >
            {refCopied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                已引用
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                引用
              </>
            )}
          </button>
          <button
            type="button"
            className="c0de-cb__copy"
            data-copied={String(copied)}
            onClick={handleCopy}
            aria-label={copied ? "已复制" : "复制代码"}
          >
            {copied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                已复制
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                复制
              </>
            )}
          </button>
        </div>
      </div>
      <div className="c0de-cb__body">
        <pre className="c0de-cb__lines" aria-hidden="true">
          {lines.map((_, idx) => (
            <span key={idx} className="c0de-cb__lineNo">
              {idx + 1}
            </span>
          ))}
        </pre>
        <pre className="c0de-cb__code">
          <SyntaxHighlighter code={code} lang={lang} />
        </pre>
      </div>
    </div>
  );
}
