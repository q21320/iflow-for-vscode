import type { OutputBlock } from "./stream";

export type ConversationMode = "default" | "yolo" | "plan" | "smart";

// 模型配置
export let MODELS = ["qwen3.5:0.8b"] as const;
export type ModelType = (typeof MODELS)[number];

export const DEFAULT_CONTEXT_SIZE = 128000;

// Context window sizes per model (from iFlow CLI's model configuration)
export let MODEL_CONTEXT_SIZES: Record<ModelType, number> = {
  "qwen3.5:0.8b": 256000,
};

// 模型ID映射
export let MODEL_ID_MAP: Partial<Record<ModelType, string>> = {
  "qwen3.5:0.8b": "qwen3.5:0.8b",
};

// 更新模型配置
export function updateModelsConfig(models: string[], contextSizes: Record<string, number>, idMap: Record<string, string>): void {
  MODELS = models as unknown as typeof MODELS;
  MODEL_CONTEXT_SIZES = contextSizes as unknown as Record<ModelType, number>;
  MODEL_ID_MAP = idMap as unknown as Partial<Record<ModelType, string>>;
}

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
