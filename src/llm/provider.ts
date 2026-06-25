// Provider registry, routing, and fallback (§4.3, §4.6, §4.7).
//
// Responsibilities:
//   - Construct ProtocolHandler instances for each ProviderConfig.
//   - Look up a model by role (default/smol/slow/plan/commit) via RoleRouting.
//   - Run chatStream with optional FallbackChain retry across providers.

import { classifyError, extractRetryAfterMs, shouldAbortForSubAgent } from "./errors";
import type { ErrorClassification } from "./errors";
import { createAnthropicHandler } from "./protocol/anthropic";
import { createGoogleHandler } from "./protocol/google";
import { createOpenAIHandler } from "./protocol/openai";
import { createOpenAICompatHandler } from "./protocol/openai-compat";
import type {
  CacheRegistry,
  CacheStrategy,
  ChatRequest,
  FallbackChain,
  FallbackChainRuntime,
  ModelRole,
  ProtocolHandler,
  ProviderConfig,
  ProviderHealthState,
  ProviderInstance,
  ProviderRegistry,
  ResolvedModel,
  RetryContext,
  RetryLogEntry,
  RetryStrategy,
  RoleBinding,
  RoleRouting,
  StreamChunk,
} from "./types";

// ---------------------------------------------------------------------------
// Handler dispatch by _tag
// ---------------------------------------------------------------------------

export function createHandler(config: ProviderConfig): ProtocolHandler {
  switch (config._tag) {
    case "openai":
      return createOpenAIHandler(config);
    case "openai-compat":
      return createOpenAICompatHandler(config);
    case "anthropic":
      return createAnthropicHandler(config);
    case "google":
      return createGoogleHandler(config);
  }
}

function createNotImplementedHandler(name: string): ProtocolHandler {
  return {
    name,
    async *chat(_request: ChatRequest, _config: ProviderConfig): AsyncGenerator<StreamChunk> {
      yield {
        _tag: "error",
        message: `Provider '${name}' is not implemented yet`,
        retriable: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function createProviderRegistry(
  configs: ProviderConfig[],
  options?: { routing?: RoleRouting; fallback?: FallbackChain },
): ProviderRegistry {
  const providers = new Map<string, ProviderInstance>();
  for (const config of configs) {
    const handler = createHandler(config);
    providers.set(handler.name, { config, handler });
  }
  const registry: ProviderRegistry = { providers };
  if (options?.routing) registry.routing = options.routing;
  if (options?.fallback) registry.fallback = options.fallback;
  return registry;
}

export function addProvider(registry: ProviderRegistry, config: ProviderConfig): ProviderInstance {
  const handler = createHandler(config);
  const instance: ProviderInstance = { config, handler };
  registry.providers.set(handler.name, instance);
  return instance;
}

export function getProvider(
  registry: ProviderRegistry,
  name: string,
): ProviderInstance | undefined {
  return registry.providers.get(name);
}

export function setRoleRouting(registry: ProviderRegistry, routing: RoleRouting): void {
  registry.routing = routing;
}

// ---------------------------------------------------------------------------
// chatStream — dispatch a request to a single provider/model.
// ---------------------------------------------------------------------------

export async function* chatStream(
  registry: ProviderRegistry,
  request: ChatRequest,
): AsyncGenerator<StreamChunk> {
  // Request may carry an explicit provider hint in "provider/model" form.
  const resolved = resolveRequestModel(registry, request);
  const instance = registry.providers.get(resolved.provider);
  if (!instance) {
    yield {
      _tag: "error",
      message: `Unknown provider: ${resolved.provider}`,
      retriable: false,
      code: "unknown_provider",
    };
    return;
  }

  yield* safeChat(instance, { ...request, model: resolved.model });
}

// ---------------------------------------------------------------------------
// Role routing (§4.6)
// ---------------------------------------------------------------------------

export function resolveModel(registry: ProviderRegistry, role: ModelRole): ResolvedModel {
  if (!registry.routing) {
    throw new Error("ProviderRegistry has no role routing configured");
  }
  return resolveBinding(registry, registry.routing[role._tag]);
}

export function resolveRoleBinding(
  registry: ProviderRegistry,
  role: ModelRole["_tag"],
): ResolvedModel {
  if (!registry.routing) {
    throw new Error(`ProviderRegistry has no role routing configured (role=${role})`);
  }
  return resolveBinding(registry, registry.routing[role]);
}

function resolveBinding(
  registry: ProviderRegistry,
  binding: RoleBinding | undefined,
): ResolvedModel {
  if (!binding) {
    throw new Error("Role binding is undefined");
  }
  if (!registry.providers.has(binding.provider)) {
    throw new Error(`Unknown provider in role binding: ${binding.provider}`);
  }
  return { provider: binding.provider, model: binding.model };
}

/**
 * Accept "provider/model" strings as an override on top of role routing.
 * Useful for per-request model pins (`model: "openai/gpt-4o"`).
 */
function resolveRequestModel(registry: ProviderRegistry, request: ChatRequest): ResolvedModel {
  const slash = request.model.indexOf("/");
  if (slash > 0) {
    const provider = request.model.slice(0, slash);
    const model = request.model.slice(slash + 1);
    if (registry.providers.has(provider)) {
      return { provider, model };
    }
  }
  // Fallback: the request's model name is treated as a default-role call
  // against the registry's default routing.
  if (registry.routing?.default) {
    return registry.routing.default;
  }
  // Last resort: pick any provider; the caller must have set up routing.
  const first = registry.providers.values().next().value;
  if (!first) {
    throw new Error("ProviderRegistry is empty");
  }
  return { provider: first.handler.name, model: request.model };
}

// ---------------------------------------------------------------------------
// Retry strategy (§4.7 — quota-aware runtime fallback)
// ---------------------------------------------------------------------------

/**
 * Compute the per-error-type retry strategy.
 *
 * Error types and their retry semantics:
 *   - context_overflow:  never retry (needs compaction/trimming)
 *   - quota_exceeded:    never retry (hard billing limit)
 *   - quota_temporary:   sub-agents abort; main agent retries ×2 with 5 s base
 *   - quota_unknown:     sub-agents abort; main agent retries ×1 with 10 s base
 *   - rate_limited:      retry ×3, 1 s base, exponential ×2, cap 30 s
 *   - auth_error:        never retry (wrong credentials)
 *   - network_error:     retry ×3, 500 ms base, exponential ×2, cap 10 s
 *   - server_error:      retry ×2, 1 s base, exponential ×2, cap 15 s
 *   - unknown:           never retry (fail-closed)
 */
export function getRetryStrategy(
  classification: ErrorClassification,
  context?: RetryContext,
): RetryStrategy {
  switch (classification.type) {
    case "context_overflow":
      return {
        shouldRetry: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
        abortReason: "Context window overflow \u2014 needs compaction or trimming",
      };

    case "quota_exceeded":
      return {
        shouldRetry: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
        abortReason: "Quota exhausted \u2014 hard billing limit reached",
      };

    case "quota_temporary":
      if (context?.isSubAgent) {
        return {
          shouldRetry: false,
          maxRetries: 0,
          baseDelayMs: 0,
          maxDelayMs: 0,
          backoffMultiplier: 1,
          abortReason: "Sub-agent hit temporary quota limit \u2014 aborting to prevent cascade",
        };
      }
      return {
        shouldRetry: true,
        maxRetries: 2,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
        backoffMultiplier: 3,
      };

    case "quota_unknown":
      if (context?.isSubAgent) {
        return {
          shouldRetry: false,
          maxRetries: 0,
          baseDelayMs: 0,
          maxDelayMs: 0,
          backoffMultiplier: 1,
          abortReason: "Sub-agent hit unknown quota limit \u2014 aborting to prevent cascade",
        };
      }
      return {
        shouldRetry: true,
        maxRetries: 1,
        baseDelayMs: 10_000,
        maxDelayMs: 30_000,
        backoffMultiplier: 2,
      };

    case "rate_limited":
      return {
        shouldRetry: true,
        maxRetries: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
        backoffMultiplier: 2,
      };

    case "auth_error":
      return {
        shouldRetry: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
        abortReason: "Authentication failure \u2014 check API key or credentials",
      };

    case "network_error":
      return {
        shouldRetry: true,
        maxRetries: 3,
        baseDelayMs: 500,
        maxDelayMs: 10_000,
        backoffMultiplier: 2,
      };

    case "server_error":
      return {
        shouldRetry: true,
        maxRetries: 2,
        baseDelayMs: 1_000,
        maxDelayMs: 15_000,
        backoffMultiplier: 2,
      };

    case "content_filter":
      return {
        shouldRetry: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
        abortReason: "Content policy violation \u2014 request blocked by safety filter",
      };

    case "overloaded":
      return {
        shouldRetry: true,
        maxRetries: 2,
        baseDelayMs: 5_000,
        maxDelayMs: 60_000,
        backoffMultiplier: 3,
      };

    case "model_not_found":
      return {
        shouldRetry: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
        abortReason: "Model not found \u2014 check model name or provider support",
      };

    case "tool_error":
      return {
        shouldRetry: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
        abortReason: "Tool/function call error \u2014 check tool definition or arguments",
      };

    case "request_too_large":
      return {
        shouldRetry: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
        abortReason: "Request payload too large \u2014 cannot retry without reducing size",
      };

    case "unknown":
      return {
        shouldRetry: false,
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        backoffMultiplier: 1,
        abortReason: "Unknown error \u2014 not retrying (fail-closed)",
      };
  }
}

/**
 * Compute the delay for a given retry attempt, capped at `maxDelayMs`.
 * `attempt` is 0-indexed (first retry = attempt 0).
 */
export function computeRetryDelay(strategy: RetryStrategy, attempt: number): number {
  return Math.min(
    strategy.baseDelayMs * strategy.backoffMultiplier ** attempt,
    strategy.maxDelayMs,
  );
}

// ---------------------------------------------------------------------------
// Provider health tracking for dynamic fallback (§4.7 enhanced)
// ---------------------------------------------------------------------------

/**
 * Create an empty fallback chain runtime.
 * Callers pass this into `chatStreamWithFallback` to enable dynamic
 * provider health tracking across multiple chain invocations.
 */
export function createFallbackChainRuntime(): FallbackChainRuntime {
  return {
    health: new Map(),
    activeChain: [],
    exhausted: [],
    adjustments: 0,
  };
}

/**
 * Mark a provider as permanently exhausted (hard quota limit).
 * The provider is removed from the active chain and added to the
 * exhausted list. Returns the updated runtime.
 */
export function markProviderExhausted(
  runtime: FallbackChainRuntime,
  provider: string,
  reason: string,
): void {
  runtime.health.set(provider, {
    _tag: "quota_exhausted",
    since: Date.now(),
    reason,
  });
  runtime.activeChain = runtime.activeChain.filter((p) => p !== provider);
  if (!runtime.exhausted.includes(provider)) {
    runtime.exhausted.push(provider);
  }
  runtime.adjustments++;
}

/**
 * Mark a provider as cooling down (temporary quota limit).
 * The provider is temporarily skipped but remains in the chain.
 */
export function markProviderCooldown(
  runtime: FallbackChainRuntime,
  provider: string,
  untilMs: number,
  reason: string,
): void {
  runtime.health.set(provider, {
    _tag: "cooldown",
    until: untilMs,
    reason,
  });
  runtime.adjustments++;
}

/**
 * Check whether a provider is currently available for use.
 * Returns false if the provider is exhausted or still in cooldown.
 */
export function isProviderAvailable(
  runtime: FallbackChainRuntime,
  provider: string,
): boolean {
  const state = runtime.health.get(provider);
  if (!state) return true;
  switch (state._tag) {
    case "healthy":
      return true;
    case "quota_exhausted":
      return false;
    case "cooldown":
      return Date.now() >= state.until;
  }
}

/**
 * Build the effective provider list by filtering out exhausted providers
 * and those still in cooldown. Initializes the active chain on first call.
 */
export function getActiveProviders(
  runtime: FallbackChainRuntime,
  chain: FallbackChain,
): string[] {
  // Initialize active chain on first call.
  if (runtime.activeChain.length === 0) {
    runtime.activeChain = [chain.primary, ...chain.fallbacks];
  }
  return runtime.activeChain.filter((p) => isProviderAvailable(runtime, p));
}

// ---------------------------------------------------------------------------
// Structured retry logging
// ---------------------------------------------------------------------------

/**
 * Emit a structured retry log entry.
 * Writes to `console.warn` in a human-readable format and invokes the
 * optional `onRetry` callback so callers can collect logs programmatically.
 * Includes chain state context when a runtime is available.
 */
function emitRetryLog(
  entry: RetryLogEntry,
  onRetry?: (entry: RetryLogEntry) => void,
  runtime?: FallbackChainRuntime,
): void {
  const ts = new Date(entry.timestamp).toISOString();
  const prefix = `[retry:${entry.decision}]`;
  const chainInfo = runtime
    ? ` chain=[${runtime.activeChain.join(",")}] exhausted=[${runtime.exhausted.join(",")}] adjustments=${runtime.adjustments}`
    : "";
  const detail =
    `${entry.provider} attempt ${entry.attempt}/${entry.maxRetries} ` +
    `error=${entry.errorType} delay=${entry.delayMs}ms \u2014 ${entry.reason}${chainInfo}`;
  console.warn(`${prefix} ${ts} ${detail}`);
  onRetry?.(entry);
}

// ---------------------------------------------------------------------------
// Fallback chain (§4.7 — quota-aware with dynamic chain adjustment)
// ---------------------------------------------------------------------------

/**
 * Determine whether an error is "provider-fatal" — meaning this specific
 * provider should be skipped for the rest of the chain, but the chain
 * itself can continue with other providers.
 *
 * Provider-fatal errors:
 *   - quota_exceeded:  hard billing limit — provider is done.
 *   - auth_error:      wrong credentials — won't fix itself.
 *
 * Non-provider-fatal (chain-fatal or retryable):
 *   - context_overflow: affects all providers equally.
 *   - quota_temporary:  cooldown, then retry.
 *   - rate_limited:     retry with backoff.
 *   - network/server:  transient.
 */
function isProviderFatal(classification: ErrorClassification): boolean {
  switch (classification.type) {
    case "quota_exceeded":
    case "auth_error":
      return true;
    default:
      return false;
  }
}

export async function* chatStreamWithFallback(
  registry: ProviderRegistry,
  request: ChatRequest,
  chain: FallbackChain,
  context?: RetryContext,
): AsyncGenerator<StreamChunk> {
  // Use or create a runtime for dynamic chain tracking.
  const runtime = context?.runtime ?? createFallbackChainRuntime();
  const activeProviders = getActiveProviders(runtime, chain).filter((name) =>
    registry.providers.has(name),
  );

  if (activeProviders.length === 0) {
    yield {
      _tag: "error",
      message: "Fallback chain contains no available providers",
      retriable: false,
      code: "fallback_empty",
    };
    return;
  }

  let lastError: StreamChunk | undefined;

  // Iterate through the active provider list. When a provider hits a
  // provider-fatal error, it is marked exhausted and we advance to the
  // next. When a provider hits a retryable error, we retry it up to the
  // budget before moving on.
  let pi = 0;
  while (pi < activeProviders.length) {
    const providerName = activeProviders[pi];
    const instance = registry.providers.get(providerName);
    if (!instance) {
      pi++;
      continue;
    }

    // Re-check availability (cooldown may have expired).
    if (!isProviderAvailable(runtime, providerName)) {
      pi++;
      continue;
    }

    if (pi > 0 || runtime.adjustments > 0) {
      emitRetryLog(
        {
          timestamp: Date.now(),
          provider: providerName,
          attempt: 0,
          maxRetries: 0,
          errorType: "fallback",
          decision: "fallback",
          delayMs: 0,
          reason: `Trying provider "${providerName}" (active: [${activeProviders.filter((p) => isProviderAvailable(runtime, p)).join(",")}])`,
        },
        context?.onRetry,
        runtime,
      );
    }

    let attempt = 0;
    const absoluteMax = chain.maxRetries;

    while (attempt <= absoluteMax) {
      const generator = safeChat(instance, request);
      let failed: StreamChunk | undefined;
      let providerFatal = false;

      // Drain the generator so a streaming failure surfaces before we
      // decide whether to retry.
      while (true) {
        const next = await generator.next();
        if (next.done) break;
        if (next.value._tag === "error") {
          failed = next.value;
          const classification = classifyError(next.value);
          const strategy = getRetryStrategy(classification, context);

          // ---- Sub-agent quota abort (prevents infinite cascades) ----
          if (context?.isSubAgent && shouldAbortForSubAgent(classification)) {
            emitRetryLog(
              {
                timestamp: Date.now(),
                provider: providerName,
                attempt,
                maxRetries: strategy.maxRetries,
                errorType: classification.type,
                decision: "abort",
                delayMs: 0,
                reason: `Sub-agent abort: ${strategy.abortReason ?? classification.type}`,
              },
              context.onRetry,
              runtime,
            );
            yield next.value;
            return;
          }

          // ---- Provider-fatal: mark exhausted, skip to next ----
          if (isProviderFatal(classification)) {
            const reason = strategy.abortReason ?? `${classification.type} on ${providerName}`;
            markProviderExhausted(runtime, providerName, reason);
            emitRetryLog(
              {
                timestamp: Date.now(),
                provider: providerName,
                attempt,
                maxRetries: 0,
                errorType: classification.type,
                decision: "skip",
                delayMs: 0,
                reason: `Provider-fatal: ${reason} \u2014 skipping`,
              },
              context?.onRetry,
              runtime,
            );
            providerFatal = true;
            break;
          }

          // ---- Temporary cooldown: mark and skip ----
          if (classification.type === "quota_temporary") {
            const retryAfterMs = extractRetryAfterMs(next.value);
            const cooldownMs = retryAfterMs ?? strategy.baseDelayMs * strategy.backoffMultiplier;
            markProviderCooldown(runtime, providerName, Date.now() + cooldownMs, classification.message);
            emitRetryLog(
              {
                timestamp: Date.now(),
                provider: providerName,
                attempt,
                maxRetries: strategy.maxRetries,
                errorType: classification.type,
                decision: "skip",
                delayMs: cooldownMs,
                reason: `Temporary quota \u2014 cooling down ${cooldownMs}ms`,
              },
              context?.onRetry,
              runtime,
            );
            providerFatal = true;
            break;
          }

          // ---- Non-retriable chain-fatal (e.g. context_overflow) ----
          if (!strategy.shouldRetry) {
            emitRetryLog(
              {
                timestamp: Date.now(),
                provider: providerName,
                attempt,
                maxRetries: strategy.maxRetries,
                errorType: classification.type,
                decision: "abort",
                delayMs: 0,
                reason: strategy.abortReason ?? `Non-retriable: ${classification.type}`,
              },
              context?.onRetry,
              runtime,
            );
            yield next.value;
            return;
          }

          // ---- Retriable: check budget ----
          const effectiveMax = Math.min(absoluteMax, strategy.maxRetries);
          if (attempt >= effectiveMax) {
            emitRetryLog(
              {
                timestamp: Date.now(),
                provider: providerName,
                attempt,
                maxRetries: effectiveMax,
                errorType: classification.type,
                decision: "fallback",
                delayMs: 0,
                reason: `Retry budget exhausted (${attempt}/${effectiveMax}) for ${classification.type}`,
              },
              context?.onRetry,
              runtime,
            );
            break;
          }

          // ---- Schedule retry with computed backoff ----
          const retryAfterMs = extractRetryAfterMs(next.value);
          const delayMs = retryAfterMs ?? computeRetryDelay(strategy, attempt);
          const retryAfterHint = retryAfterMs ? ", server hint" : "";
          emitRetryLog(
            {
              timestamp: Date.now(),
              provider: providerName,
              attempt: attempt + 1,
              maxRetries: effectiveMax,
              errorType: classification.type,
              decision: "retry",
              delayMs,
              reason: `Retrying after ${classification.type} (${delayMs}ms${retryAfterHint}, base=${strategy.baseDelayMs}ms, x${strategy.backoffMultiplier})`,
            },
            context?.onRetry,
            runtime,
          );
          await delay(delayMs);
          break; // Exit inner drain loop; outer while-loop retries.
        }
        yield next.value;
      }

      // Provider-fatal or cooldown: skip to next provider.
      if (providerFatal) break;

      if (!failed) {
        // Successful response.
        if (attempt > 0) {
          emitRetryLog(
            {
              timestamp: Date.now(),
              provider: providerName,
              attempt,
              maxRetries: absoluteMax,
              errorType: "none",
              decision: "success",
              delayMs: 0,
              reason: `Succeeded after ${attempt} retries`,
            },
            context?.onRetry,
            runtime,
          );
        }
        return;
      }

      lastError = failed;
      attempt++;
    }

    // Move to next provider in the active chain.
    pi++;

    // Rebuild active list in case cooldowns expired during retries.
    const refreshed = getActiveProviders(runtime, chain).filter((name) =>
      registry.providers.has(name),
    );
    if (refreshed.length > activeProviders.length) {
      // A cooled-down provider became available — update the iteration list.
      activeProviders.length = 0;
      activeProviders.push(...refreshed);
    }
  }

  // All providers exhausted — surface the last error.
  if (lastError && lastError._tag === "error") {
    const classification = classifyError(lastError);
    emitRetryLog(
      {
        timestamp: Date.now(),
        provider: "(all)",
        attempt: 0,
        maxRetries: 0,
        errorType: classification.type,
        decision: "abort",
        delayMs: 0,
        reason: `All providers exhausted; last error: ${lastError.message}`,
      },
      context?.onRetry,
      runtime,
    );
    yield lastError;
  } else {
    yield {
      _tag: "error",
      message: "Fallback chain exhausted with no error captured",
      retriable: false,
      code: "fallback_exhausted",
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Safe invocation — guarantees that a throwing handler is converted into an
// `error` StreamChunk rather than an unhandled rejection.
// ---------------------------------------------------------------------------

async function* safeChat(
  instance: ProviderInstance,
  request: ChatRequest,
): AsyncGenerator<StreamChunk> {
  try {
    yield* instance.handler.chat(request, instance.config);
  } catch (err) {
    yield {
      _tag: "error",
      message: err instanceof Error ? err.message : String(err),
      retriable: true,
      code: "handler_threw",
    };
  }
}

// ---------------------------------------------------------------------------
// Cache strategy registry (§4.8)
// ---------------------------------------------------------------------------

export function createCacheRegistry(): CacheRegistry {
  return { strategies: new Map() };
}

export function registerCacheStrategy(registry: CacheRegistry, strategy: CacheStrategy): void {
  registry.strategies.set(strategy.provider, strategy);
}

export function applyCacheOptimization(
  registry: CacheRegistry,
  provider: string,
  request: ChatRequest,
): ChatRequest {
  const strategy = registry.strategies.get(provider);
  if (!strategy) return request;
  return strategy.apply(request);
}
