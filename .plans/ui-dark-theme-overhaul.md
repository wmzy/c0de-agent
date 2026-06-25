# UI Dark Theme + Message Bubble + Code Block + Empty State Overhaul

## Summary

Overhaul c0de-agent's web UI to a GitHub-dark aesthetic that surpasses OpenCode's
web experience. Three files change: (1) `src/styles/global.ts` — define the exact
dark palette on `:root` + `.haze-colors__darkTheme` (overriding haze-ui's built-in
#121212 values with #0d1117-based values), fix the legacy hard-coded `errorBanner`,
add thin scrollbars, selection color, list-style reset, typography tokens, and a
zero-dependency syntax-highlighting token palette. (2) `src/App.tsx` — swap
`lightTheme`→`darkTheme`. (3) `src/pages/ChatPage.tsx` — replace the bare-text
`ChatMessage` with avatar/name/timestamp/status props, add a local
`SyntaxHighlighter` + `CodeBlockView` (copy button + line numbers), a message-text
segment parser, and a hero-style empty state with gradient headline + quick-action
chips. No functionality is removed; no packages are installed.

---

## Critical Findings (from exploration)

1. **haze-ui `darkTheme` class = `.haze-colors__darkTheme`** — sets `--haze-color-*`
   to #121212-based values. App loads it as a className on the root `<div>`.
2. **haze-ui CSS is imported statically in `main.tsx` (line 3) BEFORE `App`/`global.ts`.**
   Vite outputs app CSS after haze-ui CSS → same-specificity rules in `global.ts`
   win by source order.
3. **Specificity trap**: `.haze-colors__darkTheme` (on the App div, specificity 0,1,0)
   beats `:root` (specificity 0,1,0) for vars ON the div, because a directly-applied
   var declaration beats an inherited one. → To override haze-ui's darkTheme values,
   `global.ts` MUST re-declare the palette inside a `:global(.haze-colors__darkTheme)`
   block (same element, same specificity, later source order → wins).
4. **`--haze-color-muted` is USED by haze-ui (assistant bubble bg `.haze-ChatMessage__bubbleAssistant`,
   `CodeBlock__block` bg, MarkdownRenderer `pre`/`code`/`th` bg) but NEVER DEFINED** →
   resolves to nothing. `global.ts` MUST define it in both scopes.
5. **MarkdownRenderer** compiles ``` ```lang\n…``` ``` → `<pre><code class="lang-X">`
   and inline `` `code` `` → `<code>`. Targetable via
   `:global(.haze-MarkdownRenderer__wrapper) pre code[class*="lang-"]`.
6. **CodeBlock** = `.haze-CodeBlock__block > .haze-CodeBlock__pre > code` (NO lang class
   on code). Used in ToolCallCard/FilePreview/PermissionDialog.
7. **ChatMessage props**: `{role, avatar?, name?, timestamp?, status?, children, className?}`.
   Renders `.haze-ChatMessage__wrapper` (+`__wrapperUser`), `.haze-ChatMessage__bubble`
   (+`bubbleUser`/`bubbleAssistant`/`bubbleSystem`). Role-based alignment is INTERNAL.
8. **Current ChatPage (755 lines)** already has sub-components: `MessageBubble`,
   `StreamingAssistantBlock`, `ToolCallBlock`, `ChatInputArea`. `MessageBubble` passes
   raw `text` as children (no avatar). Empty state is minimal text-only.

---

## FILE 1: `src/styles/global.ts`

**Strategy**: keep the `css\`:global(){…}\`` wrapper. Define palette at `:root`
(baseline) AND repeat inside `:global(.haze-colors__darkTheme)` (to override
haze-ui's own darkTheme values on the App div). All values per spec.

### CSS variable palette (both `:root` and `:global(.haze-colors__darkTheme)`)

```css
--haze-color-bg: #0d1117;
--haze-color-bg-subtle: #161b22;
--haze-color-bg-muted: #21262d;
--haze-color-text: #e6edf3;
--haze-color-text-secondary: #c9d1d9;
--haze-color-text-muted: #8b949e;
--haze-color-text-inverse: #0d1117;
--haze-color-border: #30363d;
--haze-color-border-hover: #484f58;
--haze-color-primary: #58a6ff;
--haze-color-primary-hover: #79b8ff;
--haze-color-primary-active: #388bfd;
--haze-color-primary-subtle: rgba(31, 111, 235, 0.2);  /* #1f6feb33 */
--haze-color-success: #3fb950;
--haze-color-warning: #d29922;
--haze-color-danger: #f85149;
--haze-color-info: #58a6ff;
--haze-color-focus-ring: rgba(88, 166, 255, 0.4);
/* haze-ui uses but never defines — must add: */
--haze-color-muted: #21262d;   /* = bg-muted; surfaces like bubbles/code blocks */
```

### Typography tokens (`:root`)

```css
--haze-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", Roboto, "Helvetica Neue", Arial, sans-serif;
--haze-font-mono: "JetBrains Mono", "Fira Code", "SF Mono", SFMono-Regular,
  ui-monospace, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace;
--haze-leading-normal: 1.6;
--haze-leading-relaxed: 1.7;
```

### Body / scrollbars / selection / list-reset / focus

```css
html, body {
  margin:0; padding:0;
  font-family: var(--haze-font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  line-height: var(--haze-leading-normal);
}
body {
  background-color: var(--haze-color-bg);
  color: var(--haze-color-text);
  transition: background-color 0.2s ease;
}
#root { min-height: 100vh; }
* { box-sizing: border-box; }
a { color: var(--haze-color-primary); text-decoration: none; transition: color .15s ease; }
a:hover { color: var(--haze-color-primary-hover); }
button { cursor: pointer; font-family: inherit; }
img { max-width: 100%; }

::selection {
  background-color: var(--haze-color-primary-subtle);
  color: var(--haze-color-primary);
}

/* thin dark scrollbars */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--haze-color-border);
  border-radius: 4px;
  border: 2px solid var(--haze-color-bg);
}
::-webkit-scrollbar-thumb:hover { background: var(--haze-color-border-hover); }
* { scrollbar-width: thin; scrollbar-color: var(--haze-color-border) transparent; }

/* list-style reset for rendered markdown */
ul, ol { list-style: none; margin: 0; padding: 0; }
/* keep semantic lists visible inside prose wrappers if needed; chat uses markdown */
:focus-visible {
  outline: 2px solid var(--haze-color-primary);
  outline-offset: 2px;
}
```

### Markdown prose polish (inside assistant bubbles) — target haze-ui wrapper

```css
:global(.haze-MarkdownRenderer__wrapper) {
  color: var(--haze-color-text);
}
:global(.haze-MarkdownRenderer__wrapper) p { margin: 0 0 0.75em; line-height: 1.7; }
:global(.haze-MarkdownRenderer__wrapper) p:last-child { margin-bottom: 0; }
:global(.haze-MarkdownRenderer__wrapper) h1,
:global(.haze-MarkdownRenderer__wrapper) h2,
:global(.haze-MarkdownRenderer__wrapper) h3 {
  margin: 1.2em 0 0.5em; line-height: 1.3; color: var(--haze-color-text);
}
:global(.haze-MarkdownRenderer__wrapper) h1 { font-size: 1.4em; }
:global(.haze-MarkdownRenderer__wrapper) h2 { font-size: 1.25em; }
:global(.haze-MarkdownRenderer__wrapper) h3 { font-size: 1.1em; }
:global(.haze-MarkdownRenderer__wrapper) a { color: var(--haze-color-primary); }
:global(.haze-MarkdownRenderer__wrapper) blockquote {
  border-left: 3px solid var(--haze-color-border);
  padding-left: 12px; margin: 0.5em 0; color: var(--haze-color-text-secondary);
}
:global(.haze-MarkdownRenderer__wrapper) li { margin: 0.25em 0; }
/* inline code (not in pre) */
:global(.haze-MarkdownRenderer__wrapper) code {
  background: var(--haze-color-bg-muted);
  color: var(--haze-color-text);
  padding: 2px 6px; border-radius: 4px; font-size: 0.875em;
  font-family: var(--haze-font-mono);
}
/* fenced code blocks produced by MarkdownRenderer: <pre><code class="lang-X"> */
:global(.haze-MarkdownRenderer__wrapper) pre {
  background: var(--haze-color-bg-muted) !important;
  border: 1px solid var(--haze-color-border);
  border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 0.75em 0;
}
:global(.haze-MarkdownRenderer__wrapper) pre code {
  background: transparent; padding: 0; font-size: 0.85em; line-height: 1.6;
}
```

### Syntax-highlighting TOKEN palette (zero-runtime CSS)

These are plain global classes; the React `SyntaxHighlighter` emits
`<span class="tok tok-keyword">…</span>`. Colors tuned for #0d1117 bg.

```css
:global(.tok) { color: var(--haze-color-text); }
:global(.tok-keyword)   { color: #ff7b72; }   /* red-pink: if/for/return/const */
:global(.tok-string)    { color: #a5d6ff; }   /* light blue: "..." '...' `...` */
:global(.tok-comment)   { color: #8b949e; font-style: italic; }
:global(.tok-number)    { color: #79c0ff; }   /* blue: 123 0x1f 1.5 */
:global(.tok-function)  { color: #d2a8ff; }   /* purple: foo( */
:global(.tok-builtin)   { color: #ffa657; }   /* orange: console, Math, self */
:global(.tok-property)  { color: #79c0ff; }   /* obj.key */
:global(.tok-operator)  { color: #ff7b72; }
:global(.tok-punct)     { color: #c9d1d9; }   /* braces, commas */
:global(.tok-tag)       { color: #7ee787; }   /* green: <div> (html tags) */
:global(.tok-attr)      { color: #79c0ff; }   /* <div class= */
:global(.tok-boolean)   { color: #79c0ff; }   /* true/false/null */
:global(.tok-plain)     { color: var(--haze-color-text); }
```

### Code-block view classes (used by CodeBlockView in ChatPage)

```css
:global(.cb) {
  background: var(--haze-color-bg-muted);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px; overflow: hidden; margin: 0.75em 0;
  font-family: var(--haze-font-mono); font-size: 13px;
}
:global(.cb__header) {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 12px; background: var(--haze-color-bg-subtle);
  border-bottom: 1px solid var(--haze-color-border);
  font-family: var(--haze-font-sans); font-size: 12px;
}
:global(.cb__lang) {
  color: var(--haze-color-text-muted); text-transform: uppercase;
  letter-spacing: 0.5px; font-weight: 600;
}
:global(.cb__copy) {
  background: transparent; border: 1px solid var(--haze-color-border);
  color: var(--haze-color-text-secondary); border-radius: 4px;
  padding: 2px 10px; font-size: 12px; cursor: pointer; transition: all .15s;
  font-family: var(--haze-font-sans);
}
:global(.cb__copy:hover) {
  background: var(--haze-color-border); color: var(--haze-color-text);
}
:global(.cb__copy--done) { color: var(--haze-color-success); border-color: var(--haze-color-success); }
:global(.cb__body) { display: flex; overflow-x: auto; }
:global(.cb__lines) {
  user-select: none; text-align: right; padding: 12px 8px 12px 14px;
  color: var(--haze-color-text-muted); background: var(--haze-color-bg-subtle);
  border-right: 1px solid var(--haze-color-border); line-height: 1.6;
}
:global(.cb__lineNo) { display: block; }
:global(.cb__code) {
  padding: 12px 14px; margin: 0; flex: 1; white-space: pre; line-height: 1.6;
}
```

### Empty-state hero classes

```css
:global(.hero) {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; gap: 16px; padding: 48px 24px; text-align: center;
}
:global(.hero__icon) { color: var(--haze-color-primary); opacity: 0.9; }
:global(.hero__title) {
  font-size: 28px; font-weight: 700; letter-spacing: -0.02em;
  background: linear-gradient(135deg, var(--haze-color-primary), #bc8cff);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
}
:global(.hero__hint) {
  font-size: 15px; color: var(--haze-color-text-muted); max-width: 380px; line-height: 1.7;
}
:global(.hero__chips) { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 8px; }
:global(.hero__chip) {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 999px;
  background: var(--haze-color-bg-muted); border: 1px solid var(--haze-color-border);
  color: var(--haze-color-text-secondary); font-size: 13px; cursor: pointer;
  transition: all .15s ease; font-family: var(--haze-font-sans);
}
:global(.hero__chip:hover) {
  border-color: var(--haze-color-primary); color: var(--haze-color-primary);
  background: var(--haze-color-primary-subtle); transform: translateY(-1px);
}
```

### Fix legacy `errorBanner` — it is now palette-based in ChatPage (uses `color-mix`),
but global.ts should ensure no stray hard-coded light colors survive. The current
ChatPage `errorBanner` already uses `var(--haze-color-danger)` via `color-mix` — GOOD,
no hard-coded `#fef2f2` remains. global.ts need only ensure `--haze-color-danger`
is dark-appropriate (done above: #f85149). No extra change needed beyond confirming.

---

## FILE 2: `src/App.tsx`

Two surgical edits:

**Import (line 2):**
```diff
- import { Button, Spinner, ToastContainer, lightTheme } from "haze-ui";
+ import { Button, Spinner, ToastContainer, darkTheme } from "haze-ui";
```

**Theme application (line 107):**
```diff
- <div className={cx(globalStyles, lightTheme)}>
+ <div className={cx(globalStyles, darkTheme)}>
```

`cx(globalStyles, darkTheme)` order: `globalStyles` first is fine — globalStyles
contains `:root` + `.haze-colors__darkTheme` overrides that win by source order
(app CSS after haze-ui CSS), independent of className string order. The className
order only affects which class string is emitted; specificity/source-order governs
the cascade. ✓

**Optional polish (AppLayout header, lines ~30-66):** the header uses inline
`borderBottom: '1px solid var(--haze-color-border)'` — already palette-based, will
go dark automatically. The `config.model` span uses
`var(--haze-color-text-muted)` — fine. No change required.

---

## FILE 3: `src/pages/ChatPage.tsx`

### 3a. Imports — add `Avatar`, `MarkdownRenderer`

```diff
  import {
    Button,
    ChatContainer,
    ChatMessage,
+   Avatar,
    CodeBlock,
    Drawer,
+   MarkdownRenderer,
    Segmented,
    Spinner,
    StreamingText,
    ThinkingIndicator,
    ToolCallCard,
  } from "haze-ui";
```

### 3b. New helper: `parseSegments(text)` — split message text into typed parts

Lives near `getTextContent`. Pure function, no state.

```ts
type Segment =
  | { type: "text"; content: string }
  | { type: "code"; lang: string; content: string };

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  // match fenced code blocks: ```lang\n...\n```  (allow missing closing fence for streaming)
  const fence = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: "text", content: text.slice(last, m.index) });
    }
    segments.push({ type: "code", lang: (m[1] || "").toLowerCase(), content: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", content: text.slice(last) });
  }
  return segments;
}
```

Edge cases: unterminated fence (streaming) → captured by `(?:```|$)`; empty lang →
`""` (SyntaxHighlighter falls back to plain); inline `` `code` `` stays inside text
segments and is styled by MarkdownRenderer's inline-code CSS.

### 3c. New helper: `tokenize(code, lang)` — regex-based syntax tokenizer

Pure function returning `{type, value}[]`. Token types map to global classes
`tok-keyword|tok-string|tok-comment|tok-number|tok-function|tok-builtin|tok-property|
tok-operator|tok-punct|tok-tag|tok-attr|tok-boolean|tok-plain`.

Design: per-language-family RULE tables `Record<string, [type, RegExp][]>`. A
master regex is built by alternation; `exec`-loop finds matches; the defined
capture group determines the type. Unmatched gaps → `tok-plain`.

Language families (aliases collapsed):
- `js|ts|jsx|tsx|javascript|typescript` — keywords (const/let/var/function/if/else/
  for/while/return/import/export/from/class/extends/new/await/async/try/catch/typeof/
  instanceof/this/super/yield/delete/void/in/of/default/break/continue/switch/case/do),
  types (boolean/string/number/any/unknown/void/never/Record/Partial/Promise), builtins
  (console/Math/JSON/Object/Array/Map/Set/Promise/Symbol/window/document/process),
  booleans (true/false/null/undefined), strings (`'…"`,`'…'`,`\`…\``, template),
  comments (`//…`,`/*…*/`), numbers, functions (`\w+(?=\()`), properties (`.\w+`).
- `py|python` — keywords (def/class/if/elif/else/for/while/return/import/from/as/with/
  try/except/finally/raise/pass/break/continue/lambda/yield/global/nonlocal/assert/del/
  in/is/not/and/or/None/True/False/self/cls), strings, comments (`#…`), decorators
  (`@name`), numbers, functions.
- `sh|bash|shell|zsh` — keywords (if/then/fi/else/elif/case/esac/for/while/do/done/
  function/return/export/local/echo/exit), comments (`#…`), strings, variables
  (`$VAR`, `${VAR}`, `$()`), flags (`\s-\w+`).
- `json` — strings (keys vs values via `(?<=:\s*)"` lookahead-ish via separate rule),
  numbers, booleans (true/false/null), punct.
- `css|scss` — selectors, properties (`\w+(?=:)`), values, at-rules (`@\w+`),
  strings, comments (`/*…*/`), hex colors (`#[0-9a-fA-F]{3,8}`), numbers.
- `html|xml|svg|vue` — tags (`<\/?\w+`, `\/?>`), attributes (`\w+(?==)`), strings,
  comments (`<!--…-->`).
- `md|markdown` — headings (`^#+`), bold/italic markers, links, code spans.
- `yaml|yml` — keys (`^\s*\w+(?=:)`), strings, numbers, booleans, comments (`#…`).
- `sql` — keywords (SELECT/FROM/WHERE/INSERT/UPDATE/DELETE/etc.), strings, comments
  (`--…`,`/*…*/`), numbers, functions.
- `go|golang` — keywords (func/package/import/var/const/type/struct/interface/for/if/
  else/return/range/go/defer/make/new/map/chan), strings, comments, numbers.
- `rs|rust` — keywords (fn/let/mut/pub/struct/enum/impl/trait/for/if/else/match/
  return/use/mod/async/await/where/unsafe), strings, comments, numbers, lifetimes.
- `java` — keywords (public/private/class/interface/extends/implements/static/void/
  int/long/double/float/boolean/String/new/return/if/else/for/while/try/catch),
  strings, comments, numbers, annotations (`@\w+`).
- `c|cpp|c++|h` — keywords (int/char/void/float/double/struct/union/enum/if/else/for/
  while/return/const/static/include/define/typedef/class/public/private/template/
  typename/namespace), preprocessor (`#include`/`#define`), strings, comments, numbers.
- fallback (unknown lang / `""`) → single `tok-plain` token (no coloring; still gets
  code-block chrome + line numbers + copy).

Implementation note: build a SINGLE combined `RegExp` per family via
`new RegExp(rules.map(r=>`(${r[1].source})`).join('|'), 'g')` and loop
`combined.exec(code)` with `lastIndex` tracking; for each match, find the first
non-undefined group index → maps back to the rule's type via a parallel array.
Escapes HTML in `value` before emitting spans.

### 3d. New component: `SyntaxHighlighter({ code, lang })`

```tsx
function SyntaxHighlighter({ code, lang }: { code: string; lang: string }) {
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);
  return (
    <code>
      {tokens.map((t, i) => (
        <span key={i} className={`tok tok-${t.type}`}>{t.value}</span>
      ))}
    </code>
  );
}
```

`useMemo` keyed on `[code, lang]` so tokenization runs once per message
(important: messages are immutable once committed). `key={i}` is fine for static
token lists (no reorder).

### 3e. New component: `CodeBlockView({ code, lang })`

Replaces the use of haze-ui `CodeBlock` inside message content. Uses the
`.cb*` global classes. Local `copied` state for the copy button.

```tsx
function CodeBlockView({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");
  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);
  const displayLang = lang || "text";
  return (
    <div className="cb">
      <div className="cb__header">
        <span className="cb__lang">{displayLang}</span>
        <button className={cx("cb__copy", copied && "cb__copy--done")} onClick={handleCopy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <div className="cb__body">
        <div className="cb__lines">
          {lines.map((_, i) => (<span className="cb__lineNo" key={i}>{i + 1}</span>))}
        </div>
        <pre className="cb__code">
          <SyntaxHighlighter code={code} lang={lang} />
        </pre>
      </div>
    </div>
  );
}
```

Note: `cb*` classes are emitted as literal global class strings (not linaria
`css` template), because they're defined as `:global(.cb…)` in global.ts. Use
plain string `"cb"` / template `tok-${t.type}` — NOT linaria classNames.

### 3f. New component: `MessageContent({ text })` — renders parsed segments

Replaces the raw `{text}` passed as ChatMessage children. Assistant/system
messages get markdown + code blocks; user messages get plain text + code blocks
(user input rarely has markdown but may paste code).

```tsx
function MessageContent({ text, isUser }: { text: string; isUser: boolean }) {
  const segments = useMemo(() => parseSegments(text), [text]);
  if (segments.length === 1 && segments[0].type === "text" && !isUser) {
    // pure text assistant message → MarkdownRenderer (handles inline code, headings, lists)
    return <MarkdownRenderer content={text} />;
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeBlockView key={i} code={seg.content} lang={seg.lang} />
        ) : isUser ? (
          <span key={i} style={{ whiteSpace: "pre-wrap" }}>{seg.content}</span>
        ) : seg.content.trim() ? (
          <MarkdownRenderer key={i} content={seg.content} />
        ) : null,
      )}
    </>
  );
}
```

### 3g. Modify `MessageBubble` — add avatars + use MessageContent

Current (lines ~383-416) passes `name` and raw `{text}` children. Change to:

```tsx
function MessageBubble({ role, text, status, timestamp, toolCalls }) {
  const isUser = role === "user";
  return (
    <div className={messageRow}>
      <ChatMessage
        role={role}
        name={isUser ? "你" : role === "system" ? "System" : "Assistant"}
        avatar={isUser ? <Avatar size="sm" fallback="你" /> : <Avatar size="sm" fallback="AI" />}
        timestamp={timestamp ? formatTimestamp(timestamp) : undefined}
        status={status}
      >
        <MessageContent text={text} isUser={isUser} />
      </ChatMessage>
      {toolCalls?.length ? (
        <div className={toolCallStack} style={{ marginTop: 8 }}>
          {toolCalls.map((tc) => (
            <div className={toolCallContainer} key={tc.id}>
              <ToolCallCard name={tc.name} status="done"
                input={tc.arguments ? <CodeBlock language="json">{tc.arguments}</CodeBlock> : undefined} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

The old `userBubble`/`assistantBubble`/`systemBubble`/`messageBubble` styles are
already REMOVED in the current refactor (ChatMessage handles role styling
internally via `.haze-ChatMessage__bubbleUser/Assistant/System`). Confirm no
leftover references to those removed `css` consts (they don't exist in current
755-line file). ✓

### 3h. Modify empty state — hero icon + gradient headline + quick-action chips

Replace the `showEmpty` block (lines ~731-739). The chips fill `ChatInputArea`'s
value. Since `ChatInputArea` owns its own `value` state, expose a ref/callback OR
lift the fill into a controlled approach. **Simplest correct approach**: add an
`initialValue` prop to `ChatInputArea` and a `pendingPrompt` state in ChatPage
that, when a chip is clicked, sets the input via an imperative handle.

Implementation: convert `ChatInputArea` to accept a `draftRef` (useImperativeHandle)
OR — cleaner — lift `value` up: ChatPage holds `draft` state, passes `value` +
`onChange` to `ChatInputArea`. But that's a larger refactor.

**Minimal-change approach**: keep `ChatInputArea` self-contained, add an
`initialDraft` prop + `key` reset. When a chip is clicked, ChatPage sets
`chipDraft` state and bumps `chatInputKey` to force remount with new initial value.

```tsx
// ChatPage state:
const [chipDraft, setChipDraft] = useState<string | null>(null);
const [chatInputKey, setChatInputKey] = useState(0);

const handleChip = useCallback((prompt: string) => {
  setChipDraft(prompt);
  setChatInputKey((k) => k + 1);  // remount ChatInputArea seeded with the prompt
}, []);
```

```tsx
<ChatInputArea
  key={chatInputKey}
  initialDraft={chipDraft}
  disabled={isStreaming}
  onSend={sendMessage}
  onAbort={abort}
/>
```

In `ChatInputArea`, change `useState("")` → `useState(initialDraft ?? "")`.

**Empty state JSX** (replaces the `emptyChat` block):

```tsx
{showEmpty ? (
  <div className="hero">
    <svg className="hero__icon" width="64" height="64" viewBox="0 0 64 64" fill="none">
      {/* chat bubble + code brackets merged icon */}
      <path d="M10 14a6 6 0 0 1 6-6h32a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H30l-10 8v-8h-4a6 6 0 0 1-6-6V14Z"
        stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"/>
      <path d="M24 22l-5 5 5 5M40 22l5 5-5 5M34 20l-4 14"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
    <h2 className="hero__title">开始对话</h2>
    <p className="hero__hint">
      输入消息与 AI 助手对话，它将帮助你编写、调试和理解代码。
    </p>
    <div className="hero__chips">
      {QUICK_ACTIONS.map((a) => (
        <button key={a.label} className="hero__chip" onClick={() => handleChip(a.prompt)}>
          <span>{a.icon}</span> {a.label}
        </button>
      ))}
    </div>
  </div>
) : ( …existing messages… )}
```

**QUICK_ACTIONS constant** (near tunables):
```ts
const QUICK_ACTIONS = [
  { label: "解释这段代码", icon: "📖", prompt: "请帮我解释下面这段代码：\n\n```\n" },
  { label: "修复 bug", icon: "🐛", prompt: "我遇到了一个 bug，请帮我分析并修复：\n\n```\n" },
  { label: "写一个新功能", icon: "✨", prompt: "请帮我实现以下功能：\n\n" },
] as const;
```

### 3i. Streaming text — keep StreamingText for the live typewriter

`StreamingAssistantBlock` keeps using `<StreamingText text={streamingText} …/>`
inside `streamingBubble`. For consistency, optionally wrap streaming text in
`MessageContent` once committed — but during streaming, raw StreamingText is
correct (avoid re-tokenizing partial fences every tick). No change needed.

### 3j. Confirm untouched behavior

These remain EXACTLY as-is: `StreamingAssistantBlock`, `ToolCallBlock`,
`ChatInputArea` (except added `initialDraft` prop), sidebar/`Segmented`/
`BranchTree`/`FileBrowser`/`LLMDetails`, `Drawer`, `topBar`, permission dialog,
error banner, auto-scroll (`ChatContainer autoScroll`). The `ChatInputArea`
`key`-remount on chip click only resets the textarea value — all its handlers
remain attached.

---

## Sequence

1. **global.ts** (no dependencies) — palette + tokens + scrollbar + selection +
   list-reset + markdown prose + `.tok*` palette + `.cb*` + `.hero*`. This is
   the foundation; do it first so ChatPage's class references resolve.
2. **App.tsx** — `lightTheme`→`darkTheme` (2-line edit, independent of ChatPage).
3. **ChatPage.tsx** — add imports → `parseSegments` → `tokenize` →
   `SyntaxHighlighter` → `CodeBlockView` → `MessageContent` → modify
   `MessageBubble` (avatars) → `QUICK_ACTIONS` + chip state → modify empty
   state → add `initialDraft` to `ChatInputArea`. Order matters: helpers before
   components that use them.

---

## Edge Cases & Error Conditions

- **Unmatched regex / catastrophic backtracking**: each language family regex uses
  anchored alternation with non-overlapping token classes; no nested quantifiers
  like `(a+)+`. Tokenize is O(n) per message. Guard: wrap tokenize in try/catch →
  on throw, return `[{type:"plain", value: code}]` (graceful plain fallback).
- **Unterminated code fence during streaming**: `parseSegments` regex
  `(?:```|$)` captures the open fence. The streaming view uses raw `StreamingText`
  (not `parseSegments`), so partial-fence artifacts only appear transiently.
- **Empty code block** (` ``` ``` `): `lines = [""]`, renders 1 line number, empty
  code. Fine.
- **Unknown language**: `tokenize` returns one `plain` token → code block renders
  with chrome but no colors. Acceptable (spec allows subset).
- **`navigator.clipboard` undefined** (non-secure context): optional-chained
  `?.writeText` → no-op; copy button won't error. Could add a fallback
  `document.execCommand('copy')` but out of scope.
- **Avatar `fallback="你"` / `"AI"`**: haze-ui Avatar renders fallback as text in
  a circle when no `src`. Confirmed by Avatar.d.ts (`fallback?: ReactNode`).
- **Very long code**: `cb__body` has `overflow-x:auto`; line numbers column is
  non-scrolling (sticky left). Keep `user-select:none` on line numbers so copy
  via button gets clean code.
- **CSS `!important` on MarkdownRenderer `pre` bg**: needed because haze-ui's
  `.haze-MarkdownRenderer__wrapper pre { background: var(--haze-color-muted) }`
  sets the var (now defined as #21262d) — actually since we DEFINE
  `--haze-color-muted`, haze-ui's own rule will produce the right color. The
  `!important` is a safety net; can drop it if `--haze-color-muted` is reliably
  defined. Prefer defining the var and NOT using `!important`.
- **`color-mix` support**: `errorBanner`/`inputWrapperError` use `color-mix(in srgb,…)`.
  Supported in Chrome 111+/Safari 16.2+/Firefox 113+. Acceptable for a dev tool.
- **linaria `:global()` scoping**: all haze-ui class targets (`haze-MarkdownRenderer__wrapper`)
  and our `.tok`/`.cb`/`.hero` MUST be inside `:global(…)` or the linaria
  processor will hash them. The current global.ts wraps everything in a single
  top-level `:global() { … }` block — all nested selectors are global. ✓ Keep
  that structure.

---

## Verification

1. **Typecheck**: `pnpm typecheck` (tsc --noEmit) — must pass with new
   `Avatar`/`MarkdownRenderer` imports and `parseSegments`/`tokenize` types.
2. **Build**: `pnpm build` — vite + wyw-in-js must compile linaria `css` templates
   and emit global classes without errors.
3. **Lint**: `pnpm lint` (biome) — no unused imports (`CodeBlock` still used in
   ToolCallBlock; ensure `MarkdownRenderer`/`Avatar` are used).
4. **Runtime smoke (dev server `pnpm dev`)**:
   - Page loads dark (#0d1117 body bg).
   - Empty state shows SVG icon + gradient "开始对话" + 3 chips.
   - Clicking a chip fills the textarea with the prompt; chip remount via key.
   - Send a message → user bubble right-aligned, blue bg, avatar "你".
   - Assistant reply → left-aligned, muted bg, avatar "AI", name "Assistant".
   - Assistant message containing ``` ```js const x = 1 ``` ``` → CodeBlockView
     with line number "1", blue `const`, blue `1`, copy button shows "复制"→"已复制".
   - Inline `` `code` `` in markdown → highlighted inline code chip.
   - Tool call card renders with json CodeBlock (unchanged).
   - Streaming shows typewriter cursor (unchanged).
   - Permission dialog appears on tool approval (unchanged).
   - Sidebar tabs (会话/文件/LLM) switch correctly (unchanged).
5. **Contrast check**: text #e6edf3 on #0d1117 ≈ 15:1 (AAA); primary #58a6ff on
   #0d1117 ≈ 4.6:1 (AA); muted #8b949e on #0d1117 ≈ 4.7:1 (AA).
6. **No regressions**: grep that `lightTheme` no longer appears anywhere in `src/`;
   grep that removed bubble consts (`userBubble`/`assistantBubble`/`systemBubble`)
   are not referenced.

---

## Critical Files to Read (for implementer)

- `src/styles/global.ts` (current 82 lines) — the `:global(){…}` wrapper pattern.
- `src/App.tsx` lines 2, 107 — theme import + application.
- `src/pages/ChatPage.tsx` (current 755 lines) — `MessageBubble` (~383),
  `StreamingAssistantBlock` (~352), `ChatInputArea` (~440), empty-state (~731),
  imports (~15), tunables (~27).
- haze-ui type defs (read-only reference): `node_modules/.pnpm/haze-ui@1.6.0…/dist/types/components/{ChatMessage,CodeBlock,MarkdownRenderer,Avatar,StreamingText,ToolCallCard,ThinkingIndicator,Empty,Chip}/*.d.ts`
- haze-ui compiled CSS (read-only): `node_modules/.pnpm/haze-ui@1.6.0…/dist/haze-ui.css` —
  `.haze-colors__darkTheme` block + `.haze-ChatMessage__*` / `.haze-CodeBlock__*` rules.
- `src/core/types.ts` lines 89-106 — `Message` / `MessageContentPart` shape.
