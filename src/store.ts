import * as vscode from 'vscode';
import {
  Conversation,
  ConversationState,
  ConversationMode,
  ModelType,
  Message,
  AttachedFile,
  StreamChunk,
  MODELS,
  MODEL_CONTEXT_SIZES,
} from './protocol';
import { applyChunkToMessage } from './store/chunkReducer';
import { updateConversationById as applyConversationUpdate, deriveConversationTitle, createConversationId } from './store/conversationMutations';
import { estimateConversationContextUsage, ContextUsage } from './store/contextUsageEstimator';
import {
  INITIAL_RUNTIME_STATE_SNAPSHOT,
  RuntimeStateSnapshot,
  RuntimeStateSource,
} from './store/runtimeStateSource';

const STORAGE_KEY = 'iflow.conversations';

interface AppendAssistantOptions {
  notify?: boolean;
}

interface PersistedConversationState {
  currentConversationId: string | null;
  conversations: Conversation[];
}

interface SavedConversationState {
  currentId: string | null;
  conversations: Conversation[];
  cliAvailable?: boolean;
  cliVersion?: string | null;
  cliDiagnostics?: string | null;
}

export interface ConversationStoreOptions {
  useRuntimeSnapshot?: boolean;
}

function cloneRuntimeSnapshot(snapshot: RuntimeStateSnapshot): RuntimeStateSnapshot {
  return {
    ...snapshot,
    workspaceFolders: snapshot.workspaceFolders.map((folder) => ({ ...folder })),
  };
}

export class ConversationStore {
  private state: PersistedConversationState;
  private readonly memento: vscode.Memento;
  private readonly onStateChange: (state: ConversationState) => void;
  private readonly useRuntimeSnapshot: boolean;
  private readonly runtimeStateSource: RuntimeStateSource;
  private legacyRuntimeState: RuntimeStateSnapshot;
  private batchDepth = 0;
  private readonly acpUsedTokensByConversationId = new Map<string, number>();

  constructor(
    memento: vscode.Memento,
    onStateChange: (state: ConversationState) => void,
    options: ConversationStoreOptions = {},
  ) {
    this.memento = memento;
    this.onStateChange = onStateChange;
    this.useRuntimeSnapshot = options.useRuntimeSnapshot ?? true;

    const saved = memento.get<SavedConversationState>(STORAGE_KEY);

    this.state = {
      currentConversationId: saved?.currentId || null,
      conversations: saved?.conversations || [],
    };

    const initialRuntimeState: RuntimeStateSnapshot = {
      ...INITIAL_RUNTIME_STATE_SNAPSHOT,
      cliAvailable: saved?.cliAvailable ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliAvailable,
      cliVersion: saved?.cliVersion ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliVersion,
      cliDiagnostics: saved?.cliDiagnostics ?? INITIAL_RUNTIME_STATE_SNAPSHOT.cliDiagnostics,
    };
    this.runtimeStateSource = new RuntimeStateSource(initialRuntimeState);
    this.legacyRuntimeState = cloneRuntimeSnapshot(initialRuntimeState);
  }

  getState(): ConversationState {
    const current = this.getCurrentConversation();
    const runtime = this.getRuntimeStateSnapshot();
    return {
      ...this.state,
      ...runtime,
      contextUsage: this.resolveContextUsage(current),
    };
  }

  getCurrentConversation(): Conversation | null {
    if (!this.state.currentConversationId) {
      return null;
    }
    return this.state.conversations.find((c) => c.id === this.state.currentConversationId) || null;
  }

  setCliStatus(available: boolean, version: string | null, diagnostics?: string): void {
    if (this.useRuntimeSnapshot) {
      this.runtimeStateSource.setCliStatus(available, version, diagnostics);
    } else {
      this.legacyRuntimeState = {
        ...this.legacyRuntimeState,
        cliAvailable: available,
        cliVersion: version,
        cliDiagnostics: diagnostics ?? null,
      };
      this.save();
    }
    this.notifyChange();
  }

  setWorkspaceFolders(folders: Array<{ uri: string; name: string }>): void {
    if (this.useRuntimeSnapshot) {
      this.runtimeStateSource.setWorkspaceFolders(folders);
    } else {
      this.legacyRuntimeState = {
        ...this.legacyRuntimeState,
        workspaceFolders: [...folders],
        isMultiRoot: folders.length > 1,
      };
    }
    this.notifyChange();
  }

  setConversationWorkspaceFolder(uri: string): void {
    const updated = this.updateCurrentConversation((conversation) => ({
      ...conversation,
      workspaceFolderUri: uri,
      updatedAt: Date.now(),
    }));
    if (updated) {
      this.save();
      this.notifyChange();
    }
  }

  setStreaming(streaming: boolean): void {
    if (this.useRuntimeSnapshot) {
      this.runtimeStateSource.setStreaming(streaming);
    } else {
      this.legacyRuntimeState = {
        ...this.legacyRuntimeState,
        isStreaming: streaming,
      };
    }
    this.notifyChange();
  }

  newConversation(workspaceFolderUri?: string): Conversation {
    const current = this.getCurrentConversation();
    const conversation: Conversation = {
      id: createConversationId(),
      title: 'New Conversation',
      messages: [],
      mode: 'default',
      think: current?.think ?? false,
      model: current?.model ?? MODELS[0],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceFolderUri: workspaceFolderUri ?? current?.workspaceFolderUri,
    };

    this.state = {
      ...this.state,
      conversations: [conversation, ...this.state.conversations],
      currentConversationId: conversation.id,
    };
    this.save();
    this.notifyChange();
    return conversation;
  }

  switchConversation(conversationId: string): void {
    const conversation = this.state.conversations.find((c) => c.id === conversationId);
    if (!conversation) {
      return;
    }

    this.state = { ...this.state, currentConversationId: conversationId };
    this.save();
    this.notifyChange();
  }

  deleteConversation(conversationId: string): void {
    const index = this.state.conversations.findIndex((c) => c.id === conversationId);
    if (index === -1) {
      return;
    }
    this.acpUsedTokensByConversationId.delete(conversationId);

    const conversations = this.state.conversations.filter((c) => c.id !== conversationId);
    const currentConversationId = this.state.currentConversationId === conversationId
      ? (conversations[0]?.id || null)
      : this.state.currentConversationId;

    this.state = {
      ...this.state,
      conversations,
      currentConversationId,
    };
    this.save();
    this.notifyChange();
  }

  clearCurrentConversation(): void {
    const currentConversationId = this.state.currentConversationId;
    if (currentConversationId) {
      this.acpUsedTokensByConversationId.delete(currentConversationId);
    }

    const updated = this.updateCurrentConversation((conversation) => ({
      ...conversation,
      messages: [],
      title: 'New Conversation',
      sessionId: undefined,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.save();
      this.notifyChange();
    }
  }

  setMode(mode: ConversationMode): void {
    const conversation = this.getCurrentConversation() ?? this.newConversation();
    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      mode,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.save();
      this.notifyChange();
    }
  }

  setThink(enabled: boolean): void {
    const conversation = this.getCurrentConversation() ?? this.newConversation();
    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      think: enabled,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.save();
      this.notifyChange();
    }
  }

  setModel(model: ModelType): void {
    const conversation = this.getCurrentConversation() ?? this.newConversation();
    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      model,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.save();
      this.notifyChange();
    }
  }

  setSessionId(sessionId: string): void {
    const updated = this.updateCurrentConversation((conversation) => ({
      ...conversation,
      sessionId,
    }));

    if (updated) {
      this.save();
      this.notifyChange();
    }
  }

  clearSessionId(): void {
    const updated = this.updateCurrentConversation((conversation) => ({
      ...conversation,
      sessionId: undefined,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.save();
      this.notifyChange();
    }
  }

  addUserMessage(content: string, attachedFiles: AttachedFile[]): Message {
    let conversation = this.getCurrentConversation();
    if (!conversation) {
      conversation = this.newConversation();
    }

    const message: Message = {
      id: createConversationId(),
      role: 'user',
      content,
      blocks: [{ type: 'text', content }],
      attachedFiles,
      timestamp: Date.now(),
    };

    const userCount = conversation.messages.filter((m) => m.role === 'user').length + 1;
    const nextTitle = userCount === 1 ? deriveConversationTitle(content) : conversation.title;

    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      messages: [...current.messages, message],
      title: nextTitle,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.save();
      this.notifyChange();
    }

    return message;
  }

  startAssistantMessage(): Message {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      throw new Error('No current conversation');
    }

    const message: Message = {
      id: createConversationId(),
      role: 'assistant',
      content: '',
      blocks: [],
      attachedFiles: [],
      timestamp: Date.now(),
      streaming: true,
    };

    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      messages: [...current.messages, message],
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.notifyChange();
    }

    return message;
  }

  appendToAssistantMessage(chunk: StreamChunk, options: AppendAssistantOptions = {}): void {
    const shouldNotify = options.notify ?? true;
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      return;
    }

    if (chunk.chunkType === 'usage') {
      if (this.updateAcpUsage(conversation, chunk)) {
        if (shouldNotify) {
          this.notifyChange();
        }
      }
      return;
    }

    const lastIndex = conversation.messages.length - 1;
    const lastMessage = conversation.messages[lastIndex];
    if (!lastMessage || lastMessage.role !== 'assistant') {
      return;
    }

    const updatedMessage = applyChunkToMessage(lastMessage, chunk);
    if (updatedMessage === lastMessage) {
      return;
    }

    const updated = this.updateConversationById(conversation.id, (current) => {
      const messages = [...current.messages];
      messages[lastIndex] = updatedMessage;
      return { ...current, messages };
    });

    if (updated && shouldNotify) {
      this.notifyChange();
    }
  }

  publishState(): void {
    this.notifyChange();
  }

  endAssistantMessage(): void {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      return;
    }

    const lastIndex = conversation.messages.length - 1;
    const lastMessage = conversation.messages[lastIndex];
    if (!lastMessage || lastMessage.role !== 'assistant') {
      return;
    }

    const collapsedBlocks = lastMessage.blocks.map((block) => (
      block.type === 'thinking'
        ? { ...block, collapsed: true }
        : block
    ));

    const finishedMessage: Message = {
      ...lastMessage,
      streaming: false,
      blocks: collapsedBlocks,
    };

    const updated = this.updateConversationById(conversation.id, (current) => {
      const messages = [...current.messages];
      messages[lastIndex] = finishedMessage;
      return {
        ...current,
        messages,
        updatedAt: Date.now(),
      };
    });

    if (updated) {
      this.save();
      this.notifyChange();
    }
  }

  private save(): void {
    const payload: SavedConversationState = {
      conversations: this.state.conversations,
      currentId: this.state.currentConversationId,
    };

    if (!this.useRuntimeSnapshot) {
      payload.cliAvailable = this.legacyRuntimeState.cliAvailable;
      payload.cliVersion = this.legacyRuntimeState.cliVersion;
      payload.cliDiagnostics = this.legacyRuntimeState.cliDiagnostics;
    }

    void this.memento.update(STORAGE_KEY, payload);
  }

  private notifyChange(): void {
    if (this.batchDepth === 0) {
      this.onStateChange(this.getState());
    }
  }

  batchUpdate(fn: () => void): void {
    this.batchDepth += 1;
    try {
      fn();
    } finally {
      this.batchDepth = Math.max(0, this.batchDepth - 1);
    }
    if (this.batchDepth === 0) {
      this.notifyChange();
    }
  }

  private updateCurrentConversation(updater: (conversation: Conversation) => Conversation): Conversation | null {
    if (!this.state.currentConversationId) {
      return null;
    }
    return this.updateConversationById(this.state.currentConversationId, updater);
  }

  private updateConversationById(
    conversationId: string,
    updater: (conversation: Conversation) => Conversation,
  ): Conversation | null {
    const { nextState, updatedConversation } = applyConversationUpdate(this.state, conversationId, updater);
    this.state = nextState;
    return updatedConversation;
  }

  private getRuntimeStateSnapshot(): RuntimeStateSnapshot {
    if (this.useRuntimeSnapshot) {
      return this.runtimeStateSource.getSnapshot();
    }
    return cloneRuntimeSnapshot(this.legacyRuntimeState);
  }

  private resolveContextUsage(conversation: Conversation | null): ContextUsage {
    if (!conversation) {
      return { usedTokens: 0, totalTokens: 128000, percent: 0 };
    }

    const acpUsedTokens = this.acpUsedTokensByConversationId.get(conversation.id);
    if (acpUsedTokens === undefined) {
      return estimateConversationContextUsage(conversation);
    }

    const totalTokens = MODEL_CONTEXT_SIZES[conversation.model] || 128000;
    const percent = totalTokens > 0 ? Math.min(100, Math.round((acpUsedTokens / totalTokens) * 100)) : 0;
    return {
      usedTokens: acpUsedTokens,
      totalTokens,
      percent,
    };
  }

  private updateAcpUsage(
    conversation: Conversation,
    chunk: Extract<StreamChunk, { chunkType: 'usage' }>,
  ): boolean {
    const usedTokens = chunk.promptTokens ?? chunk.totalTokens ?? chunk.completionTokens;
    if (usedTokens === undefined) {
      return false;
    }

    const normalized = Math.max(0, Math.round(usedTokens));
    const previous = this.acpUsedTokensByConversationId.get(conversation.id);
    if (previous === normalized) {
      return false;
    }
    this.acpUsedTokensByConversationId.set(conversation.id, normalized);
    return true;
  }
}
