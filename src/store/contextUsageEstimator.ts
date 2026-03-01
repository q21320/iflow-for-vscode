import {
  Conversation,
  DEFAULT_CONTEXT_SIZE,
  MODEL_CONTEXT_SIZES,
} from "../protocol";

export interface ContextUsage {
  usedTokens: number;
  totalTokens: number;
  percent: number;
}

/**
 * Fallback when no real ACP usage data is available.
 *
 * Returns zeroed usage (no fake estimate) so the UI honestly shows
 * "no data" rather than a misleading <1% number.
 *
 * Real usage comes from ACP `session/update` or `session/prompt`
 * responses and is stored via `ConversationService.updateAcpUsage()`.
 */
export function estimateConversationContextUsage(
  conversation: Conversation | null,
): ContextUsage {
  const totalTokens = conversation
    ? MODEL_CONTEXT_SIZES[conversation.model] || DEFAULT_CONTEXT_SIZE
    : DEFAULT_CONTEXT_SIZE;
  return { usedTokens: 0, totalTokens, percent: 0 };
}
