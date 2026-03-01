import { Conversation, StreamChunk } from "../protocol";

export interface AppendAssistantOptions {
  notify?: boolean;
}

export interface PersistedConversationState {
  currentConversationId: string | null;
  conversations: Conversation[];
}

export interface SavedConversationState {
  currentId: string | null;
  conversations: Conversation[];
  cliAvailable?: boolean;
  cliVersion?: string | null;
  cliDiagnostics?: string | null;
}

export interface ConversationStoreOptions {}

export type UsageChunk = Extract<StreamChunk, { chunkType: "usage" }>;
