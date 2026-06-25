// Think-mode system (§think-mode enhanced).
//
// Multi-mode thinking support with automatic model selection.
// Modes: quick / thorough / creative / auto / none
//
// - quick:     fast reasoning, prefers cheaper/faster models
// - thorough:  deep step-by-step reasoning, prefers thinking-capable models
// - creative:  brainstorming/divergent thinking, prefers high-capability models
// - auto:      keyword-based auto-detection (legacy behavior)
// - none:      no special thinking mode
//
// Inspired by Oh-My-OpenAgent's auto-switch patterns.

import type { ThinkMode, ThinkModeState, ThinkingClassification } from "../core/types";
import type { ProviderRegistry } from "../llm";
import { getModelCapabilities, listRegisteredModels } from "../llm";

// ---------------------------------------------------------------------------
// Keyword dictionaries per mode
// ---------------------------------------------------------------------------

/** Keywords that trigger thorough/deep thinking mode. */
const THOROUGH_KEYWORDS = [
  "think carefully",
  "think step by step",
  "think through",
  "deep thinking",
  "deeply analyze",
  "reasoning",
  "step by step",
  "一步一步",
  "仔细想想",
  "深度思考",
  "深入分析",
  "逐步推理",
  "详细分析",
  "thorough",
  "in-depth",
  "comprehensive analysis",
];

/** Keywords that trigger creative thinking mode. */
const CREATIVE_KEYWORDS = [
  "brainstorm",
  "creative",
  "innovate",
  "imagine",
  "brainstorming",
  "divergent",
  "ideate",
  "头脑风暴",
  "创意",
  "创新",
  "发散思维",
  "想象",
];

/** Keywords that trigger quick thinking mode. */
const QUICK_KEYWORDS = [
  "quick think",
  "brief analysis",
  "quick reason",
  "快速思考",
  "简要分析",
  "快速推理",
];

/** General think keywords that default to "auto" (mode determined later). */
const GENERAL_THINK_KEYWORDS = [
  "think",
  "分析",
  "推理",
  "reason",
  "analyze",
  "think about",
  "consider",
  "思考",
  "思考一下",
];

function buildRegex(keywords: string[]): RegExp {
  return new RegExp(
    keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "i",
  );
}

const THOROUGH_REGEX = buildRegex(THOROUGH_KEYWORDS);
const CREATIVE_REGEX = buildRegex(CREATIVE_KEYWORDS);
const QUICK_REGEX = buildRegex(QUICK_KEYWORDS);
const GENERAL_THINK_REGEX = buildRegex(GENERAL_THINK_KEYWORDS);

// ---------------------------------------------------------------------------
// Mode classification
// ---------------------------------------------------------------------------

/**
 * Classify a user message into a think mode based on keyword matching.
 * Priority: thorough > creative > quick > general (auto) > none.
 * More specific keywords override general ones.
 */
export function classifyThinkMode(message: string): ThinkMode {
  if (THOROUGH_REGEX.test(message)) return { _tag: "thorough" };
  if (CREATIVE_REGEX.test(message)) return { _tag: "creative" };
  if (QUICK_REGEX.test(message)) return { _tag: "quick" };
  if (GENERAL_THINK_REGEX.test(message)) return { _tag: "auto" };
  return { _tag: "none" };
}

/**
 * Legacy compatibility: returns true when any think-mode keyword is detected.
 */
export function detectThinkMode(message: string): boolean {
  const mode = classifyThinkMode(message);
  return mode._tag !== "none";
}

// ---------------------------------------------------------------------------
// Auto model selection per mode
// ---------------------------------------------------------------------------

/** Model preference order for each think mode.
 * Each entry is a model name substring to match against the registry. */
const MODE_MODEL_PREFERENCES: Record<ThinkMode["_tag"], string[]> = {
  quick: ["haiku", "flash", "mini", "gpt-4o-mini", "deepseek-chat"],
  thorough: [
    "claude-opus-4",
    "claude-sonnet-4",
    "o3",
    "gemini-2.5-pro",
    "deepseek-reasoner",
  ],
  creative: [
    "claude-opus-4",
    "claude-sonnet-4",
    "gpt-4o",
    "gemini-2.5-pro",
    "gpt-4.1",
  ],
  auto: [
    "claude-opus-4",
    "claude-sonnet-4",
    "o3",
    "gemini-2.5-pro",
    "gpt-4o",
  ],
  none: [],
};

/**
 * Select the best model for a given think mode from the provider registry.
 * Checks provider-level overrides first, then built-in capabilities.
 * Returns `{ provider, model }` or `null` if no suitable model is found.
 */
export function selectModelForThinkMode(
  registry: ProviderRegistry,
  mode: ThinkMode["_tag"],
): { provider: string; model: string } | null {
  if (mode === "none") return null;

  const preferences = MODE_MODEL_PREFERENCES[mode];
  if (preferences.length === 0) return null;

  // Collect all available models from the registry
  const availableModels: Array<{
    provider: string;
    model: string;
    caps: ReturnType<typeof getModelCapabilities>;
  }> = [];

  for (const [providerName, instance] of registry.providers) {
    const cfg = instance.config;
    if (cfg.models) {
      for (const [modelName, override] of Object.entries(cfg.models)) {
        const caps = getModelCapabilities(modelName);
        availableModels.push({
          provider: providerName,
          model: modelName,
          caps: { ...caps, ...(override as Partial<typeof caps>) },
        });
      }
    }
  }

  // Also check built-in registry for models not explicitly configured
  for (const modelName of listRegisteredModels()) {
    const caps = getModelCapabilities(modelName);
    if (!availableModels.some((m) => m.model === modelName)) {
      for (const providerName of registry.providers.keys()) {
        availableModels.push({ provider: providerName, model: modelName, caps });
        break; // one provider is enough
      }
    }
  }

  // Score each available model against preferences
  let bestMatch: { provider: string; model: string; score: number } | null = null;

  for (const available of availableModels) {
    const modelLower = available.model.toLowerCase();
    const prefIndex = preferences.findIndex((p) =>
      modelLower.includes(p.toLowerCase()),
    );
    const score = prefIndex === -1 ? -1 : preferences.length - prefIndex;

    // Bonus for thinking support in thorough/auto modes
    const thinkBonus =
      (mode === "thorough" || mode === "auto") && available.caps.supportsThinking
        ? 100
        : 0;

    const totalScore = score + thinkBonus;

    if (totalScore > 0 && (!bestMatch || totalScore > bestMatch.score)) {
      bestMatch = {
        provider: available.provider,
        model: available.model,
        score: totalScore,
      };
    }
  }

  return bestMatch
    ? { provider: bestMatch.provider, model: bestMatch.model }
    : null;
}

/**
 * Legacy compatibility: find any thinking-capable model.
 */
export function findThinkingModel(
  registry: ProviderRegistry,
): { provider: string; model: string } | null {
  return selectModelForThinkMode(registry, "thorough");
}

// ---------------------------------------------------------------------------
// Thinking content classification
// ---------------------------------------------------------------------------

/** Analytical thinking indicators. */
const ANALYTICAL_PATTERNS =
  /\b(analyz|reason|proof|logic|deduc|therefore|because|implies|equivalent|contrast|compar|evaluat)\b/i;

/** Creative thinking indicators. */
const CREATIVE_PATTERNS =
  /\b(imagine|creative|alternatively|what if|brainstorm|ideate|novel|innovative|inspire|metaphor|analog)\b/i;

/** Planning thinking indicators. */
const PLANNING_PATTERNS =
  /\b(plan|step|phase|first|then|next|finally|approach|strategy|roadmap|implement|architect|design)\b/i;

/** Verification thinking indicators. */
const VERIFICATION_PATTERNS =
  /\b(verify|check|confirm|test|assert|correct|valid|accurate|error|bug|issue|problem|fix)\b/i;

/**
 * Classify a thinking text chunk into a category with confidence score.
 * Uses keyword density heuristic — the more matching tokens, the higher
 * the confidence.
 */
export function classifyThinkingContent(text: string): ThinkingClassification {
  if (!text.trim()) return { _tag: "general", confidence: 0 };

  const words = text.split(/\s+/).length;
  const minWordsForClassification = 5;

  if (words < minWordsForClassification) {
    return { _tag: "general", confidence: 0.3 };
  }

  const analyticalMatches = (text.match(ANALYTICAL_PATTERNS) || []).length;
  const creativeMatches = (text.match(CREATIVE_PATTERNS) || []).length;
  const planningMatches = (text.match(PLANNING_PATTERNS) || []).length;
  const verificationMatches = (text.match(VERIFICATION_PATTERNS) || []).length;

  // Normalize by word count for confidence
  const normalize = (count: number) =>
    Math.min(count / Math.max(words / 10, 1), 1.0);

  const scores: Array<{
    tag: ThinkingClassification["_tag"];
    confidence: number;
  }> = [
    { tag: "analytical", confidence: normalize(analyticalMatches) },
    { tag: "creative", confidence: normalize(creativeMatches) },
    { tag: "planning", confidence: normalize(planningMatches) },
    { tag: "verification", confidence: normalize(verificationMatches) },
  ];

  scores.sort((a, b) => b.confidence - a.confidence);

  const best = scores[0];
  if (best.confidence < 0.1) return { _tag: "general", confidence: 0.2 };

  return { _tag: best.tag, confidence: best.confidence } as ThinkingClassification;
}

// ---------------------------------------------------------------------------
// Think-mode state factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh ThinkModeState with default values.
 */
export function createThinkModeState(): ThinkModeState {
  return {
    mode: { _tag: "none" },
    classifications: [],
    currentThinkingText: "",
    history: [],
  };
}

/**
 * Switch think mode, recording the transition in history.
 * Returns the updated state.
 */
export function switchThinkMode(
  state: ThinkModeState,
  newMode: ThinkMode,
  reason: "auto" | "user" | "keyword",
): ThinkModeState {
  const from = state.mode._tag;
  const to = newMode._tag;
  if (from === to) return state;

  return {
    ...state,
    mode: newMode,
    history: [...state.history, { from, to, timestamp: Date.now(), reason }],
  };
}

/**
 * Reset thinking state for a new LLM response cycle.
 */
export function resetThinkingState(state: ThinkModeState): ThinkModeState {
  return {
    ...state,
    currentThinkingText: "",
    classifications: [],
  };
}
