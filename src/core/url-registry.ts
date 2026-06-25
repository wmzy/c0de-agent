// URL Scheme registry (§3.10).
//
// Provides an extensible URL-resolution framework supporting internal and
// external schemes. Built-in resolvers handle file://, skill://, and
// agent:// URIs. Consumers register custom resolvers for additional
// schemes.
//
// The registry is an opaque nominal type backed by a module-level WeakMap,
// following the same pattern as PluginRegistry in plugins/.
//
// Conventions: data + functions, no class.

import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// URLResolver — a single scheme resolver descriptor.
// ---------------------------------------------------------------------------

export type URLResolver = {
  /** The URI scheme, e.g. "file", "skill", "agent". */
  scheme: string;
  /**
   * Resolve a URL to its string content.
   *
   * The `url` argument is the full original URI including the scheme prefix
   * (e.g. `file:///path/to/file`). Implementations strip the scheme and
   * process the remainder as appropriate.
   */
  resolve: (url: string, ctx: URLResolveContext) => Promise<string>;
};

/** Context object passed to every resolve() call. */
export type URLResolveContext = {
  /** Working directory for relative path resolution. */
  cwd: string;
  /** Optional root for skill resolution (defaults to ~/.c0de/skills/). */
  skillRoot?: string;
  /** Optional GitHub token for API authentication. */
  githubToken?: string;
};

// ---------------------------------------------------------------------------
// GitHub helper: extract owner/repo from git remote.
// ---------------------------------------------------------------------------

function getGithubOwnerRepo(cwd: string): { owner: string; repo: string } {
  let remoteUrl: string;
  try {
    remoteUrl = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "resolveURL: could not determine git remote — is this a git repository?",
    );
  }

  // SSH: git@github.com:owner/repo.git
  // HTTPS: https://github.com/owner/repo.git
  const sshMatch = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  throw new Error(
    `resolveURL: could not parse owner/repo from git remote "${remoteUrl}"`,
  );
}

// ---------------------------------------------------------------------------
// URLRegistry — opaque nominal type.
// ---------------------------------------------------------------------------

declare const URLRegistryBrand: unique symbol;

export type URLRegistry = {
  readonly [URLRegistryBrand]: true;
};

// ---------------------------------------------------------------------------
// Internal reserves
// ---------------------------------------------------------------------------

const RESOLVER_STORE = new WeakMap<URLRegistry, Map<string, URLResolver>>();

// ---------------------------------------------------------------------------
// createURLRegistry — allocate a new empty registry.
// ---------------------------------------------------------------------------

export function createURLRegistry(): URLRegistry {
  const registry = {} as URLRegistry;
  RESOLVER_STORE.set(registry, new Map());
  return registry;
}

// ---------------------------------------------------------------------------
// registerURLResolver — attach a resolver for a specific scheme.
// ---------------------------------------------------------------------------

export function registerURLResolver(registry: URLRegistry, resolver: URLResolver): void {
  const store = RESOLVER_STORE.get(registry);
  if (!store) {
    throw new Error(
      "registerURLResolver: invalid URLRegistry " + "(was not created via createURLRegistry)",
    );
  }
  store.set(resolver.scheme, resolver);
}

// ---------------------------------------------------------------------------
// resolveURL — resolve a URL through the registry.
// ---------------------------------------------------------------------------

/**
 * Resolve a URL by dispatching to the handler registered for its scheme.
 *
 * If the URL has no recognised scheme prefix (e.g. just `src/main.ts`),
 * the empty-string ("") resolver is consulted — by default the file://
 * handler is registered under both "file" and "" so that bare paths work.
 *
 * Throws if no resolver is registered for the URL's scheme.
 */
export async function resolveURL(
  registry: URLRegistry,
  url: string,
  ctx: URLResolveContext,
): Promise<string> {
  const store = RESOLVER_STORE.get(registry);
  if (!store) {
    throw new Error("resolveURL: invalid URLRegistry " + "(was not created via createURLRegistry)");
  }

  const scheme = extractScheme(url);
  const resolver = store.get(scheme) ?? store.get("");
  if (!resolver) {
    throw new Error(`resolveURL: no resolver registered for scheme "${scheme}" (url="${url}")`);
  }

  return resolver.resolve(url, ctx);
}

// ---------------------------------------------------------------------------
// Scheme extraction helper.
// ---------------------------------------------------------------------------

/**
 * Extract the scheme portion of a URI string.
 *
 * Examples:
 *   "file:///foo"     → "file"
 *   "skill://my-skill" → "skill"
 *   "agent://abc123"  → "agent"
 *   "/absolute/path"  → ""        (bare path — no scheme)
 *   "relative/path"   → ""        (no scheme)
 */
function extractScheme(url: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\//.exec(url);
  return match ? match[1].toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// Built-in resolvers
// ---------------------------------------------------------------------------

// ---- file:// resolver ---------------------------------------------------

/**
 * Resolve file:// URIs and bare paths to local file contents.
 *
 * Handles:
 *   file:///absolute/path   → absolute filesystem path
 *   file://relative/path     → resolved relative to ctx.cwd
 *   /absolute/path           (when registered as bare-path handler)
 *   relative/path            (when registered as bare-path handler)
 */
function createFileResolver(): URLResolver {
  return {
    scheme: "file",
    resolve: async (url: string, ctx: URLResolveContext): Promise<string> => {
      const path = resolveFilePath(url, ctx.cwd);
      return await readFile(path, "utf-8");
    },
  };
}

/**
 * Create a bare-path ("") resolver that delegates to the file resolver.
 *
 * This allows resolveURL(registry, "src/main.ts", ctx) to work without
 * requiring the file:// prefix.
 */
function createBarePathResolver(): URLResolver {
  const fileResolver = createFileResolver();

  return {
    scheme: "",
    resolve: async (url: string, ctx: URLResolveContext): Promise<string> => {
      // Treat bare paths as file:// URLs
      const fileUrl = url.startsWith("/") ? `file://${url}` : `file://${resolve(ctx.cwd, url)}`;
      return await fileResolver.resolve(fileUrl, ctx);
    },
  };
}

// ---- skill:// resolver --------------------------------------------------

/**
 * Resolve skill:// URIs to skill definition files.
 *
 * By default skills are looked up under `<skillRoot>/<skillName>.md` or
 * `<skillRoot>/<skillName>/index.md`. The skillRoot defaults to
 * `~/.c0de/skills/` when not supplied via URLResolveContext.
 */
function createSkillResolver(): URLResolver {
  return {
    scheme: "skill",
    resolve: async (url: string, ctx: URLResolveContext): Promise<string> => {
      const skillName = url.replace(/^skill:\/\//, "");
      const root = ctx.skillRoot ?? resolve(homedir(), ".c0de", "skills");

      const candidates = [
        join(root, `${skillName}.md`),
        join(root, `${skillName}.ts`),
        join(root, `${skillName}.js`),
        join(root, skillName, "index.md"),
        join(root, skillName, "index.ts"),
        join(root, skillName, "index.js"),
      ];

      for (const candidate of candidates) {
        try {
          return await readFile(candidate, "utf-8");
        } catch {
          continue;
        }
      }

      throw new Error(`resolveURL: skill "${skillName}" not found in ${root}`);
    },
  };
}

// ---- agent:// resolver --------------------------------------------------

/**
 * Resolve agent:// URIs to agent-output artifact references.
 *
 * Since agent outputs are ephemeral in-process objects, this resolver
 * returns a structured reference string that the caller can use to
 * retrieve the actual content from the in-memory artifact store.
 *
 * The returned string format is:
 *   `agent://<agentId>` — a reference token; the caller should query
 *   the runtime artifact store for the full content.
 */
function createAgentResolver(): URLResolver {
  return {
    scheme: "agent",
    resolve: async (url: string, _ctx: URLResolveContext): Promise<string> => {
      // agent:// URIs are reference tokens — the actual content is in the
      // in-process artifact store that the caller manages. We return the
      // URI as a reference so the caller can look it up.
      const agentId = url.replace(/^agent:\/\//, "");
      if (!agentId) {
        throw new Error("resolveURL: agent:// URI requires an agent id");
      }
      // Return a token marking this as a deferred resolution. The caller
      // may use the built-in read() facility to fetch the actual artifact
      // from the session's artifact store.
      return `artifact://${agentId}`;
    },
  };
}

// ---- pr:// resolver -----------------------------------------------------

/**
 * Resolve pr:// URIs to GitHub pull request content via the REST API.
 *
 * Format: `pr://<number>` or `pr://<owner>/<repo>/<number>`
 *
 * When only a number is provided, owner/repo is inferred from the local
 * git remote `origin` in ctx.cwd. Returns the PR body, diff stats, and
 * metadata as a Markdown-formatted string.
 */
function createPrResolver(): URLResolver {
  return {
    scheme: "pr",
    resolve: async (url: string, ctx: URLResolveContext): Promise<string> => {
      const prPath = url.replace(/^pr:\/\//, "");
      if (!prPath) {
        throw new Error("resolveURL: pr:// URI requires a PR number");
      }

      // pr://<owner>/<repo>/<number> or pr://<number>
      let owner: string;
      let repo: string;
      let prNumber: string;

      const parts = prPath.split("/");
      if (parts.length === 3) {
        [owner, repo, prNumber] = parts;
      } else if (parts.length === 1) {
        const remote = getGithubOwnerRepo(ctx.cwd);
        owner = remote.owner;
        repo = remote.repo;
        prNumber = parts[0];
      } else {
        throw new Error(
          `resolveURL: pr:// URI format is pr://<number> or pr://<owner>/<repo>/<number>, got "${url}"`,
        );
      }

      if (!prNumber || !/\d+/.test(prNumber)) {
        throw new Error(`resolveURL: invalid PR number "${prNumber}"`);
      }

      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "c0de-agent",
      };
      if (ctx.githubToken) {
        headers.Authorization = `Bearer ${ctx.githubToken}`;
      }

      const resp = await fetch(apiUrl, { headers });
      if (!resp.ok) {
        throw new Error(
          `resolveURL: GitHub API returned ${resp.status} for ${apiUrl}`,
        );
      }

      const pr = (await resp.json()) as Record<string, unknown>;

      const title = pr.title ?? "(no title)";
      const body = pr.body ?? "(no description)";
      const state = pr.state ?? "unknown";
      const user = (pr.user as Record<string, unknown>)?.login ?? "unknown";
      const head = (pr.head as Record<string, unknown>)?.ref ?? "unknown";
      const base = (pr.base as Record<string, unknown>)?.ref ?? "unknown";

      return [
        `# PR #${prNumber}: ${title}`,
        `**Author:** ${user}  **State:** ${state}  **Branch:** ${head} → ${base}`,
        `**URL:** ${pr.html_url ?? apiUrl}`,
        "",
        body,
      ].join("\n");
    },
  };
}

// ---- issue:// resolver --------------------------------------------------

/**
 * Resolve issue:// URIs to GitHub issue content via the REST API.
 *
 * Format: `issue://<number>` or `issue://<owner>/<repo>/<number>`
 *
 * When only a number is provided, owner/repo is inferred from the local
 * git remote `origin` in ctx.cwd. Returns the issue body and metadata
 * as a Markdown-formatted string.
 */
function createIssueResolver(): URLResolver {
  return {
    scheme: "issue",
    resolve: async (url: string, ctx: URLResolveContext): Promise<string> => {
      const issuePath = url.replace(/^issue:\/\//, "");
      if (!issuePath) {
        throw new Error("resolveURL: issue:// URI requires an issue number");
      }

      // issue://<owner>/<repo>/<number> or issue://<number>
      let owner: string;
      let repo: string;
      let issueNumber: string;

      const parts = issuePath.split("/");
      if (parts.length === 3) {
        [owner, repo, issueNumber] = parts;
      } else if (parts.length === 1) {
        const remote = getGithubOwnerRepo(ctx.cwd);
        owner = remote.owner;
        repo = remote.repo;
        issueNumber = parts[0];
      } else {
        throw new Error(
          `resolveURL: issue:// URI format is issue://<number> or issue://<owner>/<repo>/<number>, got "${url}"`,
        );
      }

      if (!issueNumber || !/\d+/.test(issueNumber)) {
        throw new Error(`resolveURL: invalid issue number "${issueNumber}"`);
      }

      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "c0de-agent",
      };
      if (ctx.githubToken) {
        headers.Authorization = `Bearer ${ctx.githubToken}`;
      }

      const resp = await fetch(apiUrl, { headers });
      if (!resp.ok) {
        throw new Error(
          `resolveURL: GitHub API returned ${resp.status} for ${apiUrl}`,
        );
      }

      const issue = (await resp.json()) as Record<string, unknown>;

      const title = issue.title ?? "(no title)";
      const body = issue.body ?? "(no description)";
      const state = issue.state ?? "unknown";
      const user = (issue.user as Record<string, unknown>)?.login ?? "unknown";
      const labels = (issue.labels as Array<Record<string, unknown>>)
        ?.map((l) => l.name)
        .filter(Boolean)
        .join(", ") ?? "";

      return [
        `# Issue #${issueNumber}: ${title}`,
        `**Author:** ${user}  **State:** ${state}${labels ? `  **Labels:** ${labels}` : ""}`,
        `**URL:** ${issue.html_url ?? apiUrl}`,
        "",
        body,
      ].join("\n");
    },
  };
}

// ---------------------------------------------------------------------------
// Utility: convert a file:// URI (or bare path) to an absolute filesystem
// path.
// ---------------------------------------------------------------------------

function resolveFilePath(url: string, cwd: string): string {
  // Strip file:// scheme
  const path = url.startsWith("file://") ? url.slice("file://".length) : url;

  // URL-encoded chars (e.g. %20 for space)
  const decoded = decodeURIComponent(path);

  // file:///absolute/path on Unix yields /absolute/path
  if (decoded.startsWith("/") || isAbsolute(decoded)) {
    return decoded;
  }

  // file://relative/path or bare relative path
  return resolve(cwd, decoded);
}

// ---------------------------------------------------------------------------
// registerBuiltInResolvers — register all built-in resolvers at once.
// ---------------------------------------------------------------------------

  /**
   * Register all built-in URL resolvers onto a registry.
   *
   * Built-in resolvers:
   *   - `file://`   — local file content
   *   - `skill://`  — skill definition files from ~/.c0de/skills/
   *   - `agent://`  — agent-output reference tokens
   *   - `pr://`     — GitHub pull request content
   *   - `issue://`  — GitHub issue content
   *   - `""`        — bare paths treated as file://
   */
export function registerBuiltInResolvers(registry: URLRegistry): void {
  registerURLResolver(registry, createFileResolver());
  registerURLResolver(registry, createSkillResolver());
  registerURLResolver(registry, createAgentResolver());
  registerURLResolver(registry, createPrResolver());
  registerURLResolver(registry, createIssueResolver());
  registerURLResolver(registry, createBarePathResolver());
}
