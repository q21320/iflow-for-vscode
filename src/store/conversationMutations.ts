import { Conversation } from '../protocol';

export function updateConversationById<TState extends { conversations: Conversation[] }>(
  state: TState,
  conversationId: string,
  updater: (conversation: Conversation) => Conversation,
): { nextState: TState; updatedConversation: Conversation | null } {
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
    } as TState,
    updatedConversation: updated,
  };
}

export function deriveConversationTitle(content: string): string {
  const firstLine = content.split('\n')[0].trim();
  if (firstLine.length <= 50) {
    return firstLine || '新建对话';
  }
  return firstLine.substring(0, 47) + '...';
}

export function createConversationId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}
