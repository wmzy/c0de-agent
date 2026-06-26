// Config routes (§9.2).
//
// GET   /api/config — get a UI-friendly view of the current configuration
// POST  /api/config — accept a complete or partial Config and merge it
// PATCH /api/config — partial update (advanced)

import { Hono } from "hono";
import { mergeConfig, saveConfig } from "../../core";
import type { Config } from "../../core";
import type { ProviderConfig, ProviderRegistry } from "../../llm";
import { createProviderRegistry } from "../../llm";
import { badRequest, safeJson } from "../helpers";
import type { ServerDeps } from "../index";

// ---------------------------------------------------------------------------
// Config helpers — pure functions, config-specific.
// ---------------------------------------------------------------------------

/**
 * UI-friendly view of the Config — the full Config is too much for the
 * settings page to consume directly. Returns a flat shape matching the
 * ConfigContext's `fetchConfig` contract.
 */
function configView(config: Config, projects: Array<{ id: string; name: string; directory: string }> = []): {
  configured: boolean;
  model?: string;
  providers: ProviderConfig[];
  defaultProvider: string;
  defaultModel: string;
  theme: "light" | "dark" | "system";
  locale: string;
  mcpServers: Config["mcpServers"];
  projects: Array<{ id: string; name: string; directory: string }>;
} {
  const first = config.providers[0];
  return {
    configured: config.providers.length > 0 && Boolean(first?.apiKey),
    model: config.defaultModel,
    providers: config.providers,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    theme: config.theme,
    locale: config.locale,
    mcpServers: config.mcpServers,
    projects,
  };
}

/**
 * Translate the UI's flat `{ apiKey, baseUrl, model, provider? }` into a
 * `ProviderConfig`. Routes to native `openai` for the official OpenAI base
 * URL and to `openai-compat` for everything else.
 */
function buildProviderConfig(input: {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}): ProviderConfig {
  const tag = inferProviderTag(input.providerName, input.baseUrl);

  switch (tag) {
    case "openai":
      return {
        _tag: "openai",
        apiKey: input.apiKey,
        ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
      };
    case "anthropic":
      return {
        _tag: "anthropic",
        apiKey: input.apiKey,
        ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
      };
    case "google":
      return {
        _tag: "google",
        apiKey: input.apiKey,
        ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
      };
    default:
      return {
        _tag: "openai-compat",
        apiKey: input.apiKey,
        baseURL: input.baseUrl,
        ...(input.providerName ? { label: input.providerName } : {}),
      };
  }
}

function inferProviderTag(providerName: string, baseUrl: string): "openai" | "openai-compat" | "anthropic" | "google" {
  const normalizedName = providerName.trim().toLowerCase();
  const normalizedUrl = baseUrl.trim().toLowerCase();

  // Native provider routing by name or URL
  if (normalizedName === "openai") return "openai";
  if (normalizedName === "anthropic") return "anthropic";
  if (normalizedName === "google" || normalizedName === "gemini") return "google";

  // URL-based detection
  if (
    normalizedUrl === "" ||
    normalizedUrl === "https://api.openai.com/v1" ||
    normalizedUrl === "https://api.openai.com/v1/"
  ) {
    return "openai";
  }
  if (normalizedUrl.includes("anthropic.com")) return "anthropic";
  if (normalizedUrl.includes("googleapis.com")) return "google";

  // Everything else goes through OpenAI-compatible handler
  return "openai-compat";
}

/**
 * Deduplicate provider configs by `_tag` so we keep at most one entry per
 * protocol. When duplicates exist, the last occurrence wins.
 */
function dedupeProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const byTag = new Map<ProviderConfig["_tag"], ProviderConfig>();
  for (const p of providers) {
    byTag.set(p._tag, p);
  }
  return Array.from(byTag.values());
}

/**
 * Rebuild the in-memory ProviderRegistry in place. We mutate the existing
 * `providers` Map so any agent that already captured the registry reference
 * immediately sees the new providers on its next `chatStream` call, without
 * needing a server restart.
 */
function rebuildProviderRegistry(registry: ProviderRegistry, providers: ProviderConfig[]): void {
  const fresh = createProviderRegistry(providers);
  registry.providers.clear();
  for (const [name, instance] of Array.from(fresh.providers.entries())) {
    registry.providers.set(name, instance);
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerConfigRoutes(app: Hono, deps: ServerDeps): void {
  // GET /api/config — get a UI-friendly view of the current configuration.
  app.get("/api/config", async (c) => {
    const projects = deps.sessionStore ? await deps.sessionStore.listProjects() : [];
    const projectList = projects.map((p) => ({ id: p.id, name: p.name, directory: p.directory }));
    return c.json(configView(deps.config, projectList));
  });

  // POST /api/config — accept a complete Config or Partial<Config> and
  // merge it into the live configuration. Backward-compatible with the
  // legacy flat { apiKey, baseUrl, model, provider? } shape.
  app.post("/api/config", async (c) => {
    const body = await safeJson(c);
    if (!body || typeof body !== "object") {
      return badRequest(c, "Request body must be a JSON object");
    }

    let partial: Partial<Config>;

    // Backward compatibility: detect the legacy flat provider shape
    // { apiKey, baseUrl, model, provider? } sent by ConfigContext.
    if (typeof body.apiKey === "string" && typeof body.model === "string") {
      const apiKey = body.apiKey.trim();
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      const model = body.model.trim();
      const providerName = typeof body.provider === "string" ? body.provider.trim() : "";
      if (!apiKey) return badRequest(c, "apiKey is required");

      const providerConfig = buildProviderConfig({ providerName, baseUrl, apiKey, model });
      const keepExisting = body.keepExisting === true;
      const providers = keepExisting
        ? dedupeProviders([...deps.config.providers, providerConfig])
        : [providerConfig];

      partial = {
        providers,
        defaultProvider: providerConfig._tag,
        defaultModel: model,
      };
    } else {
      // Full or partial Config object — pass through as-is.
      partial = body as Partial<Config>;
    }

    // Merge the partial update into the live config.
    deps.config = mergeConfig(deps.config, partial);

    // Rebuild the in-memory ProviderRegistry so the next chat call
    // picks up any provider changes immediately.
    rebuildProviderRegistry(deps.providerRegistry, deps.config.providers);

    try {
      await saveConfig(deps.config, "global");
    } catch {
      // Non-fatal: config may be read-only in some environments.
    }

    return c.json(configView(deps.config));
  });

  // PATCH /api/config — partial update (advanced). Mirrors POST's
  // registry-rebuild + persistence so a PATCH that touches providers also
  // takes effect immediately.
  app.patch("/api/config", async (c) => {
    const body = await safeJson(c);
    if (!body || typeof body !== "object") {
      return badRequest(c, "Request body must be a JSON object");
    }
    // Merge the partial config into the existing config.
    deps.config = mergeConfig(deps.config, body as Partial<Config>);
    rebuildProviderRegistry(deps.providerRegistry, deps.config.providers);
    try {
      await saveConfig(deps.config, "project", { projectDir: deps.workingDirectory });
    } catch {
      // Non-fatal: config may be read-only in some environments.
    }
    return c.json(configView(deps.config));
  });
}
