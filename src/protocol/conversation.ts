import type { OutputBlock } from "./stream";

export type ConversationMode = "default" | "yolo" | "plan" | "smart";

export const MODELS = [
  "GLM-4.7",
  "GLM-5",
  "DeepSeek-V3.2",
  "iFlow-ROME-30BA3B(Preview)",
  "Qwen3-Coder-Plus",
  "Kimi-K2-Thinking",
  "MiniMax-M2.5",
  "MiniMax-M2.1",
  "Kimi-K2-0905",
  "Kimi-K2.5",
] as const;

export type ModelType = (typeof MODELS)[number];

export const DEFAULT_CONTEXT_SIZE = 128000;

// Context window sizes per model (from iFlow CLI's model configuration)
export const MODEL_CONTEXT_SIZES: Record<ModelType, number> = {
  "GLM-4.7": 200000,
  "GLM-5": 200000,
  "DeepSeek-V3.2": 128000,
  "iFlow-ROME-30BA3B(Preview)": 256000,
  "Qwen3-Coder-Plus": 256000,
  "Kimi-K2-Thinking": 256000,
  "MiniMax-M2.5": 128000,
  "MiniMax-M2.1": 128000,
  "Kimi-K2-0905": 256000,
  "Kimi-K2.5": 262144,
};

// Attached file
export interface AttachedFile {
  path: string;
  content?: string;
  truncated?: boolean;
}

// IDE context from the active editor
export interface IDEContext {
  activeFile: { path: string; name: string } | null;
  selection: {
    filePath: string;
    fileName: string;
    text: string;
    lineStart: number;
    lineEnd: number;
  } | null;
}

// Message in conversation
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  blocks: OutputBlock[];
  attachedFiles: AttachedFile[];
  timestamp: number;
  streaming?: boolean;
}

// Conversation state
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  mode: ConversationMode;
  think: boolean;
  model: ModelType;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  workspaceFolderUri?: string;
}

export interface ConversationState {
  currentConversationId: string | null;
  conversations: Conversation[];
  cliAvailable: boolean;
  cliVersion: string | null;
  cliDiagnostics: string | null;
  isStreaming: boolean;
  contextUsage?: { usedTokens: number; totalTokens: number; percent: number };
  workspaceFolders: Array<{ uri: string; name: string }>;
  isMultiRoot: boolean;
}
