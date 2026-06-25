// ---------------------------------------------------------------------------
// SnapCompact — render messages to an image bitmap for token-efficient
// context compression. Uses Canvas 2D API (browser) with an injectable
// canvas factory for Node.js/test environments.
// ---------------------------------------------------------------------------

import type { Message } from "./types";
import { estimateMessagesTokens, renderParts } from "./context";

// -- Options ----------------------------------------------------------------

/** Options controlling image dimensions and appearance. */
export type SnapCompactOptions = {
  width?: number;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  padding?: number;
  /** Max messages to render (oldest dropped first). */
  maxMessages?: number;
  /** Max characters per message before truncation. */
  maxCharsPerMessage?: number;
};

// -- Data: theme colors ----------------------------------------------------

const SNAP_THEME = {
  bg: "#1e1e2e",
  userBg: "#313244",
  assistantBg: "#181825",
  systemBg: "#11111b",
  codeBg: "#11111b",
  codeBorder: "#45475a",
  text: "#cdd6f4",
  dim: "#6c7086",
  keyword: "#cba6f7",
  string: "#a6e3a1",
  number: "#fab387",
  comment: "#6c7086",
  builtin: "#89b4fa",
  function: "#89dceb",
  operator: "#f38ba8",
  tag: "#f38ba8",
  attr: "#f9e2af",
  boolean: "#fab387",
  heading: "#f5c2e7",
  bold: "#f5e0dc",
  italic: "#b4befe",
  code: "#f38ba8",
  link: "#89b4fa",
  listBullet: "#f9e2af",
} as const;

// -- Token color lookup ----------------------------------------------------

function tokenColor(tokType: string): string {
  switch (tokType) {
    case "keyword":  return SNAP_THEME.keyword;
    case "string":   return SNAP_THEME.string;
    case "number":   return SNAP_THEME.number;
    case "comment":  return SNAP_THEME.comment;
    case "builtin":  return SNAP_THEME.builtin;
    case "function": return SNAP_THEME.function;
    case "operator": return SNAP_THEME.operator;
    case "tag":      return SNAP_THEME.tag;
    case "attr":     return SNAP_THEME.attr;
    case "boolean":  return SNAP_THEME.boolean;
    default:          return SNAP_THEME.text;
  }
}

// -- Syntax tokenizer (subset, shared logic with ChatPage) -----------------

type Tok = { type: string; value: string };

export const SNAP_KEYWORDS: Record<string, string[]> = {
  javascript: ["await","async","break","case","catch","class","const","continue","debugger","default","delete","do","else","export","extends","false","finally","for","from","function","if","import","in","instanceof","let","new","null","of","return","static","super","switch","this","throw","true","try","typeof","undefined","var","void","while","with","yield"],
  typescript: ["abstract","any","as","asserts","async","await","boolean","break","case","catch","class","const","continue","debugger","declare","default","delete","do","else","enum","export","extends","false","finally","for","from","function","if","implements","import","in","instanceof","interface","is","keyof","let","namespace","never","new","null","number","object","of","private","protected","public","readonly","return","static","string","super","switch","this","throw","true","try","type","typeof","undefined","unique","unknown","var","void","while","with","yield"],
  python: ["False","None","True","and","as","assert","async","await","break","class","continue","def","del","elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not","or","pass","raise","return","try","while","with","yield","self","cls"],
  bash: ["if","then","else","elif","fi","case","esac","for","while","until","do","done","function","select","in","return","exit","break","continue","true","false","echo","cd","pwd","export","local","read","set","unset","source"],
  go: ["break","case","chan","const","continue","default","defer","else","fallthrough","for","func","go","goto","if","import","interface","map","package","range","return","select","struct","switch","type","var","true","false","nil"],
  rust: ["as","async","await","break","const","continue","crate","dyn","else","enum","extern","false","fn","for","if","impl","in","let","loop","match","mod","move","mut","pub","ref","return","self","Self","static","struct","super","trait","true","type","unsafe","use","where","while"],
  java: ["abstract","assert","boolean","break","byte","case","catch","char","class","const","continue","default","do","double","else","enum","extends","final","finally","float","for","goto","if","implements","import","instanceof","int","interface","long","native","new","package","private","protected","public","return","short","static","strictfp","super","switch","synchronized","this","throw","throws","transient","true","false","null","try","void","volatile","while"],
  sql: ["SELECT","FROM","WHERE","INSERT","INTO","VALUES","UPDATE","SET","DELETE","CREATE","TABLE","DROP","ALTER","ADD","COLUMN","INDEX","PRIMARY","KEY","FOREIGN","REFERENCES","JOIN","INNER","LEFT","RIGHT","OUTER","FULL","ON","AS","AND","OR","NOT","NULL","IS","IN","BETWEEN","LIKE","ORDER","BY","GROUP","HAVING","LIMIT","OFFSET","UNION","ALL","DISTINCT","CASE","WHEN","THEN","ELSE","END"],
  yaml: ["true","false","null","yes","no","on","off"],
};

export const SNAP_BUILTINS: Record<string, string[]> = {
  javascript: ["Array","Boolean","Date","Error","Function","JSON","Map","Math","Number","Object","Promise","Proxy","Reflect","RegExp","Set","String","Symbol","WeakMap","WeakSet","console","document","globalThis","navigator","process","window"],
  typescript: ["Array","Boolean","Date","Error","Function","JSON","Map","Math","Number","Object","Partial","Pick","Omit","Promise","Proxy","ReadonlyArray","Record","Reflect","RegExp","ReturnType","Set","String","Symbol","WeakMap","WeakSet","console","document","globalThis","navigator","process","window"],
  python: ["print","len","range","str","int","float","bool","list","tuple","dict","set","frozenset","bytes","bytearray","object","type","isinstance","issubclass","hasattr","getattr","setattr","delattr","callable","iter","next","enumerate","zip","map","filter","sorted","reversed","sum","min","max","abs","round","open","input","super","staticmethod","classmethod","property","Exception","ValueError","TypeError","KeyError","IndexError","AttributeError","IOError","FileNotFoundError","StopIteration","NotImplementedError"],
  go: ["append","cap","close","complex","copy","delete","imag","len","make","new","panic","print","println","real","recover","fmt","errors","context","strings","strconv","io","os","bufio"],
  rust: ["println","print","format","vec","panic","Some","None","Ok","Err"],
  bash: ["grep","sed","awk","cat","ls","cp","mv","rm","mkdir","rmdir","touch"],
};

export const LANG_ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", sh: "bash", shell: "bash", zsh: "bash",
  yml: "yaml", md: "markdown", html: "html", xml: "html", htm: "html",
  csharp: "java", cs: "java", cpp: "java", c: "java", h: "java",
};

function snapEscapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snapBuildMatcher(lang: string): { kw: RegExp; bi: RegExp } | null {
  const kws = SNAP_KEYWORDS[lang];
  const bis = SNAP_BUILTINS[lang] ?? [];
  if (!kws && bis.length === 0) return null;
  return {
    kw: new RegExp(`^(?:${(kws ?? []).map(snapEscapeRegex).join("|")})$`, "i"),
    bi: new RegExp(`^(?:${bis.map(snapEscapeRegex).join("|")})$`),
  };
}

function snapTokenize(code: string, lang: string): Tok[] {
  const resolved = LANG_ALIASES[(lang || "").toLowerCase()] ?? (lang || "").toLowerCase();
  const matcher = snapBuildMatcher(resolved);

  const patterns: { type: string; re: RegExp }[] = [
    { type: "comment", re: /^\/\/.*$/m },
    { type: "comment", re: /^\/\*[\s\S]*?\*\// },
    { type: "comment", re: /^#[^\n]*/ },
    { type: "comment", re: /^--[^\n]*/ },
    { type: "comment", re: /^<!--[\s\S]*?-->/ },
    { type: "string", re: /^"(?:\\.|[^"\\])*"/ },
    { type: "string", re: /^'(?:\\.|[^'\\])*'/ },
    { type: "string", re: /^`(?:\\.|[^`\\])*`/ },
    { type: "number", re: /^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?n?)/ },
    { type: "boolean", re: /^(?:true|false|null|None|True|False|nil)$/ },
  ];

  if (resolved === "html" || resolved === "xml" || resolved === "markdown") {
    patterns.push(
      { type: "tag", re: /^<\/?[a-zA-Z][a-zA-Z0-9-]*/ },
      { type: "attr", re: /^[a-zA-Z_:][a-zA-Z0-9_:.-]*(?==)/ },
    );
  }

  const out: Tok[] = [];
  let i = 0;
  let plain = "";

  const flush = () => { if (plain) { out.push({ type: "plain", value: plain }); plain = ""; } };

  while (i < code.length) {
    const rest = code.slice(i);
    if (/\s/.test(code[i]!)) { plain += code[i]; i++; continue; }

    let matched = false;
    for (const { type, re } of patterns) {
      re.lastIndex = 0;
      const m = rest.match(re);
      if (m && m.index === 0) {
        if ((type === "plain" || type === "boolean") && matcher) {
          if (matcher.kw.test(m[0])) { flush(); out.push({ type: "keyword", value: m[0] }); i += m[0].length; matched = true; break; }
          if (type !== "boolean" && matcher.bi.test(m[0])) { flush(); out.push({ type: "builtin", value: m[0] }); i += m[0].length; matched = true; break; }
        }
        flush(); out.push({ type, value: m[0] }); i += m[0].length; matched = true; break;
      }
    }
    if (matched) continue;

    const fnMatch = rest.match(/^[a-zA-Z_$][\w$]*(?=\s*\()/);
    if (fnMatch) { flush(); out.push({ type: "function", value: fnMatch[0] }); i += fnMatch[0].length; continue; }

    const idMatch = rest.match(/^[a-zA-Z_$][\w$-]*/);
    if (idMatch) {
      if (matcher) {
        if (matcher.kw.test(idMatch[0])) { flush(); out.push({ type: "keyword", value: idMatch[0] }); i += idMatch[0].length; continue; }
        if (matcher.bi.test(idMatch[0])) { flush(); out.push({ type: "builtin", value: idMatch[0] }); i += idMatch[0].length; continue; }
      }
      plain += idMatch[0]; i += idMatch[0].length; continue;
    }

    if (/[+\-*/%=<>!&|^~?:]/.test(code[i]!)) { flush(); out.push({ type: "operator", value: code[i]! }); i++; continue; }
    if (/[{}()\[\];,.]/.test(code[i]!)) { flush(); out.push({ type: "punct", value: code[i]! }); i++; continue; }

    plain += code[i]; i++;
  }
  flush();
  return out;
}

// -- Segment parser --------------------------------------------------------

type SnapSegment =
  | { _tag: "text"; content: string }
  | { _tag: "code"; lang: string; content: string };

function snapParseSegments(text: string): SnapSegment[] {
  const segments: SnapSegment[] = [];
  const fence = /```([\w-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ _tag: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ _tag: "code", lang: (match[1] || "plain").toLowerCase(), content: match[2] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ _tag: "text", content: text.slice(lastIndex) });
  }
  return segments;
}

// -- Markdown-aware inline parsing for canvas -------------------------------

type InlineSpan =
  | { _tag: "plain"; text: string }
  | { _tag: "bold"; text: string }
  | { _tag: "italic"; text: string }
  | { _tag: "code"; text: string }
  | { _tag: "heading"; level: number; text: string }
  | { _tag: "bullet"; text: string }
  | { _tag: "link"; text: string }
  | { _tag: "newline" };

function snapParseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const lines = text.split("\n");

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (li > 0) spans.push({ _tag: "newline" });

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      spans.push({ _tag: "heading", level: hMatch[1]!.length, text: hMatch[2]! });
      continue;
    }

    // Bullet list
    const bMatch = line.match(/^[\s]*[-*+]\s+(.+)$/);
    if (bMatch) {
      spans.push({ _tag: "bullet", text: bMatch[1]! });
      continue;
    }

    // Inline formatting: **bold**, *italic*, `code`, [text](url)
    const re = /(\*\*(.+?)\*\*)|\*(.+?)\*|(`[^`]+`)|\[([^\]]+)\]\([^)]+\)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) spans.push({ _tag: "plain", text: line.slice(last, m.index) });
      if (m[2]) spans.push({ _tag: "bold", text: m[2]! });
      else if (m[3]) spans.push({ _tag: "italic", text: m[3]! });
      else if (m[4]) spans.push({ _tag: "code", text: m[4]!.slice(1, -1) });
      else if (m[5]) spans.push({ _tag: "link", text: m[5]! });
      last = m.index + m[0].length;
    }
    if (last < line.length) spans.push({ _tag: "plain", text: line.slice(last) });
  }
  return spans;
}

// -- Text measurement + line wrapping --------------------------------------

function snapMeasureText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  font: string,
): number {
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Wrap text into lines that fit within `maxWidth` pixels.
 * Returns an array of { text, width } pairs.
 */
function snapWrapText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  font: string,
  maxWidth: number,
): { text: string; width: number }[] {
  ctx.font = font;
  const words = text.split(/(\s+)/);
  const lines: { text: string; width: number }[] = [];
  let current = "";

  for (const word of words) {
    const test = current + word;
    const w = ctx.measureText(test).width;
    if (w > maxWidth && current.length > 0) {
      lines.push({ text: current.trimEnd(), width: ctx.measureText(current.trimEnd()).width });
      current = word.trimStart();
    } else {
      current = test;
    }
  }
  if (current.trim()) {
    lines.push({ text: current.trim(), width: ctx.measureText(current.trim()).width });
  }
  return lines.length > 0 ? lines : [{ text: "", width: 0 }];
}

// -- Layout computation ----------------------------------------------------

type SnapBlock = {
  role: string;
  roleLabel: string;
  roleLine: { text: string; x: number; width: number };
  roleFont: string;
  textLines: { text: string; x: number; width: number; font: string; color: string; isBold: boolean }[];
  codeBlocks: { lang: string; lines: { tokens: Tok[]; lineNum: number }[]; startY: number; height: number }[];
  startY: number;
};

/**
 * Compute the layout of all message blocks. Returns the blocks and total
 * height needed. Pure function — no canvas mutation.
 */
export function snapComputeLayout(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  messages: Message[],
  opts: Required<
    Pick<SnapCompactOptions, "width" | "fontFamily" | "fontSize" | "lineHeight" | "padding" | "maxMessages" | "maxCharsPerMessage">
  >,
): { blocks: SnapBlock[]; totalHeight: number } {
  const { width, fontFamily, fontSize, lineHeight, padding, maxMessages, maxCharsPerMessage } = opts;
  const contentWidth = width - padding * 2;
  const blocks: SnapBlock[] = [];
  let y = padding;

  // Use the most recent maxMessages
  const visible = messages.slice(-maxMessages);

  for (const msg of visible) {
    const roleLabel = msg.role.toUpperCase();
    const roleFont = `bold ${fontSize}px ${fontFamily}`;
    const bodyFont = `${fontSize}px ${fontFamily}`;
    const codeFont = `${fontSize - 1}px ${fontFamily}`;
    const roleWidth = snapMeasureText(ctx, roleLabel, roleFont);

    // Role header
    const roleLine = { text: roleLabel, x: padding, width: roleWidth };
    y += lineHeight; // role line

    // Parse content
    const raw = typeof msg.content === "string" ? msg.content : renderParts(msg.content);
    const truncated = raw.length > maxCharsPerMessage
      ? raw.slice(0, maxCharsPerMessage) + "\n\n[truncated…]"
      : raw;

    const segments = snapParseSegments(truncated);
    const textLines: { text: string; x: number; width: number; font: string; color: string; isBold: boolean }[] = [];
    const codeBlocks: { lang: string; lines: { tokens: Tok[]; lineNum: number }[]; startY: number; height: number }[] = [];

    for (const seg of segments) {
      if (seg._tag === "text") {
        const spans = snapParseInline(seg.content);
        let lineText = "";
        let lineParts: { text: string; font: string; color: string; isBold: boolean }[] = [];

        const flushLine = () => {
          if (lineParts.length === 0 && lineText === "") return;
          // Combine into a single line entry (canvas doesn't support rich text natively,
          // so we use the first part's font for wrapping measurement)
          const combined = lineParts.map(p => p.text).join("") || lineText;
          const font = lineParts.length > 0 ? lineParts[0]!.font : bodyFont;
          const color = lineParts.length > 0 ? lineParts[0]!.color : SNAP_THEME.text;
          const isBold = lineParts.length > 0 ? lineParts[0]!.isBold : false;
          const wrapped = snapWrapText(ctx, combined, font, contentWidth);
          for (const wl of wrapped) {
            textLines.push({ text: wl.text, x: padding, width: wl.width, font, color, isBold });
            y += lineHeight;
          }
          lineText = "";
          lineParts = [];
        };

        for (const span of spans) {
          switch (span._tag) {
            case "newline":
              flushLine();
              break;
            case "heading":
              flushLine();
              lineParts.push({ text: span.text, font: `bold ${fontSize + (4 - span.level)}px ${fontFamily}`, color: SNAP_THEME.heading, isBold: true });
              flushLine();
              break;
            case "bold":
              lineParts.push({ text: span.text, font: `bold ${fontSize}px ${fontFamily}`, color: SNAP_THEME.bold, isBold: true });
              break;
            case "italic":
              lineParts.push({ text: span.text, font: `italic ${fontSize}px ${fontFamily}`, color: SNAP_THEME.italic, isBold: false });
              break;
            case "code":
              lineParts.push({ text: span.text, font: codeFont, color: SNAP_THEME.code, isBold: false });
              break;
            case "link":
              lineParts.push({ text: span.text, font: bodyFont, color: SNAP_THEME.link, isBold: false });
              break;
            case "bullet":
              lineParts.push({ text: `• ${span.text}`, font: bodyFont, color: SNAP_THEME.text, isBold: false });
              break;
            case "plain":
              lineParts.push({ text: span.text, font: bodyFont, color: SNAP_THEME.text, isBold: false });
              break;
          }
        }
        flushLine();
      } else {
        // Code block
        const codeLines = seg.content.split("\n");
        // Drop trailing empty line
        if (codeLines.length > 0 && codeLines[codeLines.length - 1] === "") codeLines.pop();

        const blockLines: { tokens: Tok[]; lineNum: number }[] = [];
        for (let ci = 0; ci < codeLines.length; ci++) {
          blockLines.push({ tokens: snapTokenize(codeLines[ci]!, seg.lang), lineNum: ci + 1 });
        }

        // Lang header
        y += lineHeight;
        const blockHeight = blockLines.length * lineHeight + 8; // +8 for padding
        codeBlocks.push({ lang: seg.lang, lines: blockLines, startY: y, height: blockHeight });
        y += blockHeight + 4; // +4 gap after code block
      }
    }

    // Account for role line height already added
    const block: SnapBlock = {
      role: msg.role,
      roleLabel,
      roleLine,
      roleFont,
      textLines,
      codeBlocks,
      startY: y - (textLines.length * lineHeight + codeBlocks.reduce((s, b) => s + b.height + lineHeight + 4, 0)),
    };
    blocks.push(block);
    y += lineHeight * 0.5; // gap between messages
  }

  return { blocks, totalHeight: y + padding };
}

// -- Canvas rendering ------------------------------------------------------

export function snapRenderToCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  blocks: SnapBlock[],
  opts: Required<
    Pick<SnapCompactOptions, "width" | "fontFamily" | "fontSize" | "lineHeight" | "padding">
  >,
): void {
  const { width, fontFamily, fontSize, lineHeight, padding } = opts;
  const contentWidth = width - padding * 2;

  // Background
  ctx.fillStyle = SNAP_THEME.bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  let y = padding;

  for (const block of blocks) {
    // Role background
    const roleBg = block.role === "user"
      ? SNAP_THEME.userBg
      : block.role === "system"
        ? SNAP_THEME.systemBg
        : SNAP_THEME.assistantBg;

    // Estimate block height for background
    const totalLines = block.textLines.length + block.codeBlocks.reduce((s, cb) => s + cb.lines.length + 2, 0);
    const blockHeight = (totalLines + 1) * lineHeight + 8;
    ctx.fillStyle = roleBg;
    roundRect(ctx, padding - 4, y - 4, contentWidth + 8, blockHeight, 8);

    // Role label
    ctx.fillStyle = block.role === "user"
      ? "#89b4fa"
      : block.role === "system"
        ? "#f9e2af"
        : "#a6e3a1";
    ctx.font = block.roleFont;
    ctx.fillText(block.roleLabel, padding, y + fontSize);
    y += lineHeight;

    // Text lines
    for (const tl of block.textLines) {
      ctx.font = tl.font;
      ctx.fillStyle = tl.color;
      ctx.fillText(tl.text, tl.x, y + fontSize);
      y += lineHeight;
    }

    // Code blocks
    for (const cb of block.codeBlocks) {
      // Code block background
      ctx.fillStyle = SNAP_THEME.codeBg;
      const codeBlockHeight = cb.lines.length * lineHeight + 8;
      roundRect(ctx, padding, y - 2, contentWidth, codeBlockHeight + lineHeight, 6);

      // Language label
      ctx.fillStyle = SNAP_THEME.dim;
      ctx.font = `${fontSize - 2}px ${fontFamily}`;
      ctx.fillText(cb.lang || "code", padding + 8, y + fontSize - 1);
      y += lineHeight;

      // Code lines with syntax highlighting
      for (const cl of cb.lines) {
        // Line number
        ctx.fillStyle = SNAP_THEME.dim;
        ctx.font = `${fontSize - 2}px ${fontFamily}`;
        const numStr = String(cl.lineNum).padStart(3, " ");
        ctx.fillText(numStr, padding + 8, y + fontSize);

        // Tokens
        let x = padding + 42;
        ctx.font = `${fontSize - 1}px ${fontFamily}`;
        for (const tok of cl.tokens) {
          ctx.fillStyle = tokenColor(tok.type);
          ctx.fillText(tok.value, x, y + fontSize);
          x += ctx.measureText(tok.value).width;
        }
        y += lineHeight;
      }
      y += 4; // gap after code block
    }

    y += lineHeight * 0.5; // gap between messages
  }

  // Watermark
  ctx.fillStyle = SNAP_THEME.dim;
  ctx.font = `${fontSize - 3}px ${fontFamily}`;
  ctx.fillText("SnapCompact — c0de-agent", padding, y + fontSize);
}

/** Rounded rectangle helper. */
function roundRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

// -- Canvas factory (injectable for tests / Node.js) -----------------------

export type CanvasFactory = (w: number, h: number) => {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  toBuffer: () => Promise<Uint8Array>;
};

function defaultCanvasFactory(w: number, h: number): ReturnType<CanvasFactory> {
  // Browser path: OffscreenCanvas (works in main thread, workers, and modern browsers)
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    return {
      ctx,
      toBuffer: async () => {
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const ab = await blob.arrayBuffer();
        return new Uint8Array(ab);
      },
    };
  }

  // DOM fallback: create a canvas element (for older browsers)
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    return {
      ctx,
      toBuffer: async () => {
        return new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (!blob) { reject(new Error("Canvas toBlob failed")); return; }
            blob.arrayBuffer().then(ab => resolve(new Uint8Array(ab))).catch(reject);
          }, "image/png");
        });
      },
    };
  }

  throw new Error(
    "renderMessagesToImage requires a browser environment or an explicit canvasFactory. " +
    "For Node.js, pass a factory using @napi-rs/canvas or sharp."
  );
}

// -- Public API -------------------------------------------------------------

/**
 * Render an array of messages into a PNG image bitmap.
 *
 * SnapCompact converts conversation history into a compact visual
 * representation — a single image token costs fewer tokens than the
 * raw text when the conversation is long.
 *
 * Features:
 *   • Markdown-aware rendering (headings, bold, italic, inline code, lists)
 *   • Syntax highlighting for code blocks (JS/TS/Python/Go/Rust/Java/SQL/Bash)
 *   • Catppuccin Mocha dark theme for comfortable reading
 *   • Automatic text wrapping and layout
 *   • Injectable canvas factory for Node.js/test environments
 *
 * @param messages — conversation messages to render
 * @param opts — optional rendering configuration
 * @param canvasFactory — optional canvas provider (default: browser OffscreenCanvas)
 * @returns PNG image as Uint8Array (compatible with Buffer)
 */
export async function renderMessagesToImage(
  messages: Message[],
  opts?: SnapCompactOptions,
  canvasFactory?: CanvasFactory,
): Promise<Uint8Array> {
  const resolved = {
    width: opts?.width ?? 800,
    fontFamily: opts?.fontFamily ?? "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', 'Consolas', monospace",
    fontSize: opts?.fontSize ?? 13,
    lineHeight: opts?.lineHeight ?? 20,
    padding: opts?.padding ?? 20,
    maxMessages: opts?.maxMessages ?? 50,
    maxCharsPerMessage: opts?.maxCharsPerMessage ?? 4000,
  };

  const factory = canvasFactory ?? defaultCanvasFactory;

  // First pass: compute layout with a scratch canvas to measure text
  const scratch = factory(resolved.width, 100);
  const { blocks, totalHeight } = snapComputeLayout(
    scratch.ctx, messages, resolved,
  );

  // Second pass: render to final canvas with correct height
  const height = Math.max(totalHeight, 100);
  const { ctx, toBuffer } = factory(resolved.width, Math.ceil(height));
  snapRenderToCanvas(ctx, blocks, resolved);

  return toBuffer();
}

/**
 * SnapCompact configuration: a higher-level entry point that combines
 * token estimation with image rendering. Returns the image buffer along
 * with metadata about the compression.
 */
export type SnapCompactResult = {
  image: Uint8Array;
  /** Number of messages included in the image. */
  messageCount: number;
  /** Estimated tokens consumed by the original messages. */
  originalTokens: number;
  /** Estimated tokens for the image (typically 1 image token ≈ variable). */
  imageTokenEstimate: number;
  /** Compression ratio (originalTokens / imageTokenEstimate). */
  compressionRatio: number;
};

export async function snapCompact(
  messages: Message[],
  opts?: SnapCompactOptions & { imageTokenEstimate?: number },
  canvasFactory?: CanvasFactory,
): Promise<SnapCompactResult> {
  const originalTokens = estimateMessagesTokens(messages);
  const image = await renderMessagesToImage(messages, opts, canvasFactory);
  const imageTokenEstimate = opts?.imageTokenEstimate ?? Math.ceil(image.length / 1000);

  return {
    image,
    messageCount: messages.length,
    originalTokens,
    imageTokenEstimate,
    compressionRatio: imageTokenEstimate > 0 ? originalTokens / imageTokenEstimate : Infinity,
  };
}
