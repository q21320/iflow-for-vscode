import { Conversation, ConversationState } from '../protocol';

export function updateConversationById(
  state: ConversationState,
  conversationId: string,
  updater: (conversation: Conversation) => Conversation,
): { nextState: ConversationState; updatedConversation: Conversation | null } {
  const index = state.conversations.findIndex((c) => c.id === conversationId);
  if (index === -1) {
    return { nextState: state, updatedConversation: null };
  }

  const current = state.conversations[index];
  const updated = updater(current);
  if (updated === current) {
    return { nextState: state, updatedConversation: current };
  }

  const conversations = [...state.conversations];
  conversations[index] = updated;

  return {
    nextState: {
      ...state,
      conversations,
    },
    updatedConversation: updated,
  };
}

export function deriveConversationTitle(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.length <= 50) {
    return firstLine || 'New Conversation';
  }
  return firstLine.substring(0, 47) + '...';
}

export function createConversationId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}
