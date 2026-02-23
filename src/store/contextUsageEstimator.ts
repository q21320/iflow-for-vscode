import { Conversation, MODEL_CONTEXT_SIZES } from '../protocol';

export interface ContextUsage {
  usedTokens: number;
  totalTokens: number;
  percent: number;
}

export function estimateConversationContextUsage(conversation: Conversation | null): ContextUsage {
  if (!conversation) {
    return { usedTokens: 0, totalTokens: 128000, percent: 0 };
  }

  const totalTokens = MODEL_CONTEXT_SIZES[conversation.model] || 128000;
  let usedTokens = 0;

  for (const msg of conversation.messages) {
    usedTokens += estimateTokens(msg.content);
    for (const block of msg.blocks) {
      if (block.type === 'tool' && block.output) {
        usedTokens += estimateTokens(block.output);
      }
    }
    if (msg.attachedFiles) {
      for (const file of msg.attachedFiles) {
        if (file.content) {
          usedTokens += estimateTokens(file.content);
        }
      }
    }
  }

  const percent = totalTokens > 0 ? Math.min(100, Math.round((usedTokens / totalTokens) * 100)) : 0;
  return { usedTokens, totalTokens, percent };
}

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  let tokens = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2E80) {
      tokens += 0.5;
    } else {
      tokens += 0.25;
    }
  }

  return Math.ceil(tokens);
}
