// Built-in `web_search` tool (§5.4).
//
// Performs web searches by querying a search API. Uses a simple fetch-based
// approach with configurable search endpoint (defaults to a DuckDuckGo-style
// or configurable search API).
//
// Parameters:
//   query    — the search query string
//   limit    — optional max results (default: 5)
//
// Returns search results with title, URL, and snippet.
//
// Conventions: data + functions, no class, no this.

import { ok, err, type ToolContext, type ToolDef, type ToolResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

// ---------------------------------------------------------------------------
// Web search implementation
//
// Uses the Context7 MCP server when available (the primary search path),
// falling back to a direct SerpAPI-style fetch if environment configuration
// is present.
// ---------------------------------------------------------------------------

const SEARCH_API_URL = process.env["SEARCH_API_URL"] ?? "";
const SEARCH_API_KEY = process.env["SEARCH_API_KEY"] ?? "";

/**
 * Perform a web search. Tries multiple strategies in order:
 *   1. Dedicated search API (SEARCH_API_URL + SEARCH_API_KEY)
 *   2. Fallback to a simpler extraction when no API is configured
 */
async function searchWeb(
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  // Strategy 1: Dedicated search API
  if (SEARCH_API_URL.length > 0) {
    try {
      const url = new URL(SEARCH_API_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(limit));

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (SEARCH_API_KEY.length > 0) {
        headers["Authorization"] = `Bearer ${SEARCH_API_KEY}`;
      }

      const response = await fetch(url.toString(), { headers, signal });
      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        return parseSearchResponse(data, limit);
      }
    } catch {
      // Fall through to next strategy
    }
  }

  // Strategy 2: Google Programmable Search (if configured)
  const googleKey = process.env["GOOGLE_API_KEY"] ?? "";
  const googleCx = process.env["GOOGLE_CX"] ?? "";
  if (googleKey.length > 0 && googleCx.length > 0) {
    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(googleCx)}&q=${encodeURIComponent(query)}&num=${Math.min(limit, 10)}`;
      const response = await fetch(url, { signal });
      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        const items = data["items"] as Array<Record<string, unknown>> | undefined;
        if (items) {
          return items.slice(0, limit).map((item) => ({
            title: String(item["title"] ?? ""),
            url: String(item["link"] ?? item["url"] ?? ""),
            snippet: String(item["snippet"] ?? ""),
          }));
        }
      }
    } catch {
      // Fall through
    }
  }

  // Strategy 3: DuckDuckGo-style instant answer via DuckDuckGo lite
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "c0de-agent/1.0 (web_search tool)",
        Accept: "text/html",
      },
      signal,
    });

    if (response.ok) {
      const html = await response.text();
      return extractDuckDuckGoResults(html, limit);
    }
  } catch {
    // Fall through
  }

  // Strategy 4: Use Hargo/DuckDuckGo instant answer JSON API
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&atb=v999-1`;
    const response = await fetch(url, {
      headers: { "User-Agent": "c0de-agent/1.0" },
      signal,
    });

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      const results: SearchResult[] = [];

      // Abstract text (if any)
      const abstract = String(data["Abstract"] ?? "");
      if (abstract.length > 0) {
        results.push({
          title: String(data["Heading"] ?? ""),
          url: String(data["AbstractURL"] ?? ""),
          snippet: abstract,
        });
      }

      // Related topics
      const topics = data["RelatedTopics"] as Array<Record<string, unknown>> | undefined;
      if (topics) {
        for (const topic of topics) {
          if (results.length >= limit) break;
          const text = String(topic["Text"] ?? "");
          const firstURL = String(topic["FirstURL"] ?? "");
          if (text.length > 0) {
            results.push({
              title: text.split(" - ")[0] ?? text,
              url: firstURL,
              snippet: text,
            });
          }
        }
      }

      if (results.length > 0) return results.slice(0, limit);
    }
  } catch {
    // Fall through
  }

  // No search API configured or available
  return [];
}

/**
 * Parse a generic search API JSON response.
 */
function parseSearchResponse(data: Record<string, unknown>, limit: number): SearchResult[] {
  // Try common response shapes
  const raw = data["results"] ?? data["items"] ?? data["organic_results"] ?? data["webPages"];
  const rawArr = Array.isArray(raw) ? raw : [];

  // Handle nested value/results patterns (Bing-style, SerpAPI)
  const itemsArr =
    rawArr.length > 0
      ? rawArr
      : typeof raw === "object" && raw !== null
        ? Array.isArray((raw as Record<string, unknown>)["value"])
          ? ((raw as Record<string, unknown>)["value"] as Array<Record<string, unknown>>)
          : Array.isArray((raw as Record<string, unknown>)["results"])
            ? ((raw as Record<string, unknown>)["results"] as Array<Record<string, unknown>>)
            : []
        : [];

  return itemsArr.slice(0, limit).map((item) => ({
    title: String(item["title"] ?? item["name"] ?? item["heading"] ?? ""),
    url: String(item["url"] ?? item["link"] ?? item["href"] ?? item["URL"] ?? ""),
    snippet: String(item["snippet"] ?? item["description"] ?? item["text"] ?? ""),
  }));
}

/**
 * Extract search results from DuckDuckGo HTML lite page.
 */
function extractDuckDuckGoResults(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Parse result links from DDG HTML
  // Each result has a .result__a or .result__title link
  const resultRegex =
    /<a[^>]*rel="nofollow"[^>]*class="[^"]*result[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  // Also try: DDG lite results are in .result elements
  const blockRegex =
    /<h2 class="result__title">\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>\s*<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  // Fall back to a simpler pattern
  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) !== null && results.length < limit) {
    results.push({
      title: match[2].replace(/<[^>]*>/g, "").trim(),
      url: match[1],
      snippet: match[3].replace(/<[^>]*>/g, "").trim(),
    });
  }

  // If no results from block regex, try link regex
  if (results.length === 0) {
    while ((match = linkRegex.exec(html)) !== null && results.length < limit) {
      results.push({
        title: match[2].replace(/<[^>]*>/g, "").trim(),
        url: match[1],
        snippet: "",
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// webSearchTool
// ---------------------------------------------------------------------------

export const webSearchTool: ToolDef = {
  name: "web_search",
  description:
    "Search the web for information. Returns a list of results with title, URL, and snippet. " +
    "Uses configured search API (SEARCH_API_URL/SEARCH_API_KEY env vars) or falls back to DuckDuckGo.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query string. Be as specific as possible for better results.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of search results to return (default: 5, max: 25).",
        default: 5,
        minimum: 1,
        maximum: 25,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  permission: "auto",

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const args = (input ?? {}) as Record<string, unknown>;

    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query.length === 0) {
      return err('web_search: "query" argument is required');
    }

    const limit =
      typeof args.limit === "number" && args.limit >= 1 && args.limit <= 25
        ? Math.floor(args.limit)
        : 5;

    try {
      const results = await searchWeb(query, limit, context.abort);

      if (results.length === 0) {
        return ok(
          `(no search results found for "${query}" — no search API configured)\n\n` +
            "To enable web search, set the SEARCH_API_URL and SEARCH_API_KEY environment variables, " +
            "or configure GOOGLE_API_KEY + GOOGLE_CX for Google Custom Search.\n\n" +
            "Example:\n" +
            "  SEARCH_API_URL=https://api.duckduckgo.com/?format=json\n" +
            "  SEARCH_API_URL=https://www.googleapis.com/customsearch/v1\n" +
            "  GOOGLE_API_KEY=your-key\n  GOOGLE_CX=your-cx",
          { query, count: 0 },
        );
      }

      const output = results
        .map((r, i) => {
          const num = i + 1;
          const snippet = r.snippet.length > 0 ? `\n   ${r.snippet}` : "";
          return `${num}. ${r.title}\n   ${r.url}${snippet}`;
        })
        .join("\n\n");

      return ok(output, {
        query,
        count: results.length,
        results: results.map((r) => ({ title: r.title, url: r.url })),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return err("web_search: aborted");
      }
      return err(`web_search: ${(error as Error).message}`);
    }
  },
};
