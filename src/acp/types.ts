import { AttachedFile, ConversationMode, IDEContext, ModelType, StreamChunk } from '../protocol';

export interface RunOptions {
  prompt: string;
  attachedFiles: AttachedFile[];
  mode: ConversationMode;
  think: boolean;
  model: ModelType;
  workspaceFiles?: string[];
  sessionId?: string;
  ideContext?: IDEContext;
  cwd?: string;
  fileAllowedDirs?: string[];
}

export interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface PendingPermission {
  kind: 'permission';
  resolve: (value: unknown) => void;
  options: PermissionOption[];
}

export interface PendingQuestion {
  kind: 'question';
  resolve: (value: unknown) => void;
}

export interface PendingPlan {
  kind: 'plan';
  resolve: (value: unknown) => void;
}

export type PendingInteraction = PendingPermission | PendingQuestion | PendingPlan;

export type ChunkSink = (chunk: StreamChunk) => void;

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'initializing'
  | 'ready'
  | 'disposed';

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  isConnected: boolean;
  sessionId: string | null;
  connectedCwd: string | null;
  connectedMode: ConversationMode | null;
  lastError: string | null;
}

export type ConnectionStateReason =
  | 'initial'
  | 'connect_start'
  | 'initialize_start'
  | 'ready'
  | 'dispose'
  | 'closed'
  | 'error';

export type ConnectionStateListener = (
  snapshot: ConnectionSnapshot,
  reason: ConnectionStateReason,
  error?: Error,
) => void;
