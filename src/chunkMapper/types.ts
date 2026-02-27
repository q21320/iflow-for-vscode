import { AttachedFile, IDEContext } from '../protocol';

export interface RunOptionsLike {
  prompt: string;
  attachedFiles: AttachedFile[];
  workspaceFiles?: string[];
  ideContext?: IDEContext;
  cwd?: string;
}

export interface ToolContentText {
  type?: string;
  text?: string;
}

export interface ToolContentEntry {
  type?: string;
  content?: ToolContentText;
  path?: string;
  newText?: string;
  oldText?: string | null;
  fileDiff?: string;
  args?: Record<string, unknown>;
}

export interface ToolLocation {
  path?: string;
}

export interface SessionUpdateContent {
  type?: string;
  text?: string;
}

export interface SessionUpdatePayload {
  sessionUpdate?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  title?: string | null;
  status?: string | null;
  args?: Record<string, unknown>;
  entries?: Array<{ content?: string; status?: string; priority?: string }>;
  locations?: ToolLocation[] | null;
  output?: unknown;
  type?: string;
  id?: string;
  chunk?: { thought?: string; text?: string };
  label?: string | null;
  message?: string;
  usageMetadata?: unknown;
  usage?: unknown;
  tokenUsage?: unknown;
}

export const LEGACY_MESSAGE_TYPE = {
  ASSISTANT: 'assistant',
  TOOL_CALL: 'tool_call',
  PLAN: 'plan',
  ERROR: 'error',
  TASK_FINISH: 'task_finish',
} as const;
