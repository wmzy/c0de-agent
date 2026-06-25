// Shared markdown rendering — single source of truth for all markdown → HTML.
// Uses marked (GFM) + DOMPurify sanitization.

import DOMPurify from "dompurify";
import { marked } from "marked";

// Configure marked once at module load.
marked.use({ gfm: true, breaks: false });

/**
 * Render a markdown string to sanitized HTML.
 * Use with `dangerouslySetInnerHTML` in React components.
 */
export function renderMarkdown(content: string): string {
  const html = marked.parse(content) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
