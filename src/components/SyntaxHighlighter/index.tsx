// SyntaxHighlighter — shared regex-based tokenizer + React renderer.
// Pure, no external dependencies. Used by ChatPage CodeBlock and available
// for FilePreview or any other component needing code highlighting.

import { useMemo } from "react";

// ---------------------------------------------------------------------------
// Token type
// ---------------------------------------------------------------------------

export type Tok = { type: string; value: string };

// ---------------------------------------------------------------------------
// Language keyword / builtin tables
// ---------------------------------------------------------------------------

const LANG_KEYWORDS: Record<string, string[]> = {
  javascript: [
    "await", "async", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "export", "extends", "false",
    "finally", "for", "from", "function", "if", "import", "in", "instanceof",
    "let", "new", "null", "of", "return", "static", "super", "switch", "this",
    "throw", "true", "try", "typeof", "undefined", "var", "void", "while",
    "with", "yield",
  ],
  typescript: [
    "abstract", "any", "as", "asserts", "async", "await", "boolean", "break",
    "case", "catch", "class", "const", "continue", "debugger", "declare",
    "default", "delete", "do", "else", "enum", "export", "extends", "false",
    "finally", "for", "from", "function", "if", "implements", "import", "in",
    "instanceof", "interface", "is", "keyof", "let", "namespace", "never",
    "new", "null", "number", "object", "of", "private", "protected", "public",
    "readonly", "return", "static", "string", "super", "switch", "this",
    "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown",
    "var", "void", "while", "with", "yield",
  ],
  python: [
    "False", "None", "True", "and", "as", "assert", "async", "await", "break",
    "class", "continue", "def", "del", "elif", "else", "except", "finally",
    "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
    "self", "cls",
  ],
  bash: [
    "if", "then", "else", "elif", "fi", "case", "esac", "for", "while",
    "until", "do", "done", "function", "select", "in", "return", "exit",
    "break", "continue", "true", "false", "echo", "cd", "pwd", "export",
    "local", "read", "set", "unset", "source",
  ],
  go: [
    "break", "case", "chan", "const", "continue", "default", "defer", "else",
    "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
    "map", "package", "range", "return", "select", "struct", "switch", "type",
    "var", "true", "false", "nil",
  ],
  rust: [
    "as", "async", "await", "break", "const", "continue", "crate", "dyn",
    "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let",
    "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self",
    "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
    "use", "where", "while",
  ],
  java: [
    "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
    "class", "const", "continue", "default", "do", "double", "else", "enum",
    "extends", "final", "finally", "float", "for", "goto", "if", "implements",
    "import", "instanceof", "int", "interface", "long", "native", "new",
    "package", "private", "protected", "public", "return", "short", "static",
    "strictfp", "super", "switch", "synchronized", "this", "throw", "throws",
    "transient", "true", "false", "null", "try", "void", "volatile", "while",
  ],
  sql: [
    "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
    "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "COLUMN", "INDEX",
    "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "JOIN", "INNER", "LEFT", "RIGHT",
    "OUTER", "FULL", "ON", "AS", "AND", "OR", "NOT", "NULL", "IS", "IN",
    "BETWEEN", "LIKE", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET",
    "UNION", "ALL", "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END",
  ],
  yaml: ["true", "false", "null", "yes", "no", "on", "off"],
};

const LANG_BUILTINS: Record<string, string[]> = {
  javascript: [
    "Array", "Boolean", "Date", "Error", "Function", "JSON", "Map", "Math",
    "Number", "Object", "Promise", "Proxy", "Reflect", "RegExp", "Set",
    "String", "Symbol", "WeakMap", "WeakSet", "console", "document", "globalThis",
    "navigator", "process", "window",
  ],
  typescript: [
    "Array", "Boolean", "Date", "Error", "Function", "JSON", "Map", "Math",
    "Number", "Object", "Partial", "Pick", "Omit", "Promise", "Proxy",
    "ReadonlyArray", "Record", "Reflect", "RegExp", "ReturnType", "Set",
    "String", "Symbol", "WeakMap", "WeakSet", "console", "document", "globalThis",
    "navigator", "process", "window",
  ],
  python: [
    "print", "len", "range", "str", "int", "float", "bool", "list", "tuple",
    "dict", "set", "frozenset", "bytes", "bytearray", "object", "type",
    "isinstance", "issubclass", "hasattr", "getattr", "setattr", "delattr",
    "callable", "iter", "next", "enumerate", "zip", "map", "filter", "sorted",
    "reversed", "sum", "min", "max", "abs", "round", "open", "input", "super",
    "staticmethod", "classmethod", "property", "Exception", "ValueError",
    "TypeError", "KeyError", "IndexError", "AttributeError", "IOError",
    "FileNotFoundError", "StopIteration", "NotImplementedError",
  ],
  go: [
    "append", "cap", "close", "complex", "copy", "delete", "imag", "len",
    "make", "new", "panic", "print", "println", "real", "recover", "fmt",
    "errors", "context", "strings", "strconv", "io", "os", "bufio",
  ],
  rust: ["println", "print", "format", "vec", "panic", "Some", "None", "Ok", "Err"],
  bash: ["grep", "sed", "awk", "cat", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "touch"],
};

const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "html",
  xml: "html",
  htm: "html",
  csharp: "java",
  cs: "java",
  cpp: "java",
  c: "java",
  h: "java",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLangMatcher(lang: string): { keywords: RegExp; builtins: RegExp } | null {
  const kws = LANG_KEYWORDS[lang];
  const bis = LANG_BUILTINS[lang] ?? [];
  if (!kws && bis.length === 0) return null;
  return {
    keywords: new RegExp(`^(?:${(kws ?? []).map(escapeRegex).join("|")})$`, "i"),
    builtins: new RegExp(`^(?:${bis.map(escapeRegex).join("|")})$`),
  };
}

// ---------------------------------------------------------------------------
// tokenize — pure regex-based, no dependencies
// ---------------------------------------------------------------------------

export function tokenize(code: string, lang: string): Tok[] {
  const normLang = (lang || "").toLowerCase();
  const resolved = LANG_ALIASES[normLang] ?? normLang;
  const matcher = buildLangMatcher(resolved);

  // Shared patterns (order matters)
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
    { type: "boolean", re: /^(?:true|false|null|None|True|False|nil|None)$/ },
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

  const flushPlain = () => {
    if (plain) {
      out.push({ type: "plain", value: plain });
      plain = "";
    }
  };

  while (i < code.length) {
    const rest = code.slice(i);

    // Skip whitespace verbatim
    if (/\s/.test(code[i]!)) {
      plain += code[i];
      i++;
      continue;
    }

    // Try language patterns
    let matched = false;
    for (const { type, re } of patterns) {
      re.lastIndex = 0;
      const m = rest.match(re);
      if (m && m.index === 0) {
        // Keyword/builtin promotion
        if ((type === "plain" || type === "boolean") && matcher) {
          if (matcher.keywords.test(m[0])) {
            flushPlain();
            out.push({ type: "keyword", value: m[0] });
            i += m[0].length;
            matched = true;
            break;
          }
          if (type !== "boolean" && matcher.builtins.test(m[0])) {
            flushPlain();
            out.push({ type: "builtin", value: m[0] });
            i += m[0].length;
            matched = true;
            break;
          }
        }
        flushPlain();
        out.push({ type, value: m[0] });
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Identifiers followed by `(` → function call
    const fnMatch = rest.match(/^[a-zA-Z_$][\w$]*(?=\s*\()/);
    if (fnMatch) {
      flushPlain();
      out.push({ type: "function", value: fnMatch[0] });
      i += fnMatch[0].length;
      continue;
    }

    // Plain identifier
    const idMatch = rest.match(/^[a-zA-Z_$][\w$-]*/);
    if (idMatch) {
      if (matcher) {
        if (matcher.keywords.test(idMatch[0])) {
          flushPlain();
          out.push({ type: "keyword", value: idMatch[0] });
          i += idMatch[0].length;
          continue;
        }
        if (matcher.builtins.test(idMatch[0])) {
          flushPlain();
          out.push({ type: "builtin", value: idMatch[0] });
          i += idMatch[0].length;
          continue;
        }
      }
      plain += idMatch[0];
      i += idMatch[0].length;
      continue;
    }

    // Operators / punctuation (single char)
    if (/[+\-*/%=<>!&|^~?:]/.test(code[i]!)) {
      flushPlain();
      out.push({ type: "operator", value: code[i]! });
      i++;
      continue;
    }
    if (/[{}()\[\];,.]/.test(code[i]!)) {
      flushPlain();
      out.push({ type: "punct", value: code[i]! });
      i++;
      continue;
    }

    // Fallback: single character
    plain += code[i];
    i++;
  }
  flushPlain();
  return out;
}

// ---------------------------------------------------------------------------
// SyntaxHighlighter — renders tokens as colored spans
// ---------------------------------------------------------------------------

export function SyntaxHighlighter({ code, lang }: { code: string; lang: string }) {
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);
  return (
    <code className="c0de-tok">
      {tokens.map((t, idx) => (
        <span key={idx} className={`c0de-tok-${t.type}`}>
          {t.value}
        </span>
      ))}
    </code>
  );
}
