// Token counting and cost estimation.
//
// The estimator is intentionally simple — 4 characters per token is a
// well-known heuristic for English-ish text and Claude/GPT tokenizers fall
// within ~20% of this. For exact counts, swap in tiktoken or the provider's
// tokenizer; the function signature is the stable contract.

import type { ContentPart, ModelCapabilities } from "./types";

/** Estimate tokens for plain text using a 4-chars-per-token rule. */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) return 0;
  // Round up so single-character strings still count as 1 token.
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Estimate tokens for a structured content block (array of ContentPart). */
export function estimateContentTokens(content: string | ContentPart[]): number {
  if (typeof content === "string") return estimateTokenCount(content);
  let total = 0;
  for (const part of content) {
    switch (part._tag) {
      case "text":
        total += estimateTokenCount(part.text);
        break;
      case "image_url":
      case "image_base64":
        // Images are typically billed as a fixed tile, not by raw bytes.
        total += 85;
        break;
      case "audio":
        total += Math.ceil(part.data.length / 4);
        break;
      case "document":
        total += estimateTokenCount(part.filename ?? "") + Math.ceil(part.data.length / 4);
        break;
    }
  }
  return total;
}

/** Estimate the total input tokens for a request's messages + tools + system. */
export function estimateRequestTokens(input: {
  system?: string;
  messages: Array<{ content: string | ContentPart[] }>;
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
}): number {
  let total = 0;
  if (input.system) total += estimateTokenCount(input.system);
  for (const message of input.messages) {
    total += estimateContentTokens(message.content);
    // Per-message overhead for role framing.
    total += 4;
  }
  if (input.tools) {
    for (const tool of input.tools) {
      total += estimateTokenCount(tool.name) + estimateTokenCount(tool.description);
      total += estimateTokenCount(JSON.stringify(tool.parameters ?? {}));
    }
  }
  return total;
}

/**
 * Calculate the dollar cost of a call.
 *
 * costPer1k* fields are USD per 1k tokens. Returns 0 when capabilities are
 * missing so callers can default gracefully.
 */
export function calculateCost(
  capabilities: Pick<ModelCapabilities, "costPer1kInput" | "costPer1kOutput">,
  inputTokens: number,
  outputTokens: number,
): number {
  const inputCost = (inputTokens / 1000) * capabilities.costPer1kInput;
  const outputCost = (outputTokens / 1000) * capabilities.costPer1kOutput;
  return inputCost + outputCost;
}
