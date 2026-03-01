import * as vscode from "vscode";
import {
  Conversation,
  ConversationState,
  ConversationMode,
  ModelType,
  Message,
  AttachedFile,
  StreamChunk,
} from "./protocol";
import { ContextUsage } from "./store/contextUsageEstimator";
import { ConversationRepository } from "./store/conversationRepository";
import { RuntimeStateStore } from "./store/runtimeStateStore";
import { ConversationService } from "./store/conversationService";
import {
  ConversationStoreOptions,
  PersistedConversationState,
  SavedConversationState,
  AppendAssistantOptions,
} from "./store/storeTypes";

export { ConversationStoreOptions } from "./store/storeTypes";

export class ConversationStore {
  private readonly repository: ConversationRepository;
  private readonly runtimeStateStore: RuntimeStateStore;
  private readonly conversationService: ConversationService;
  private readonly onStateChange: (state: ConversationState) => void;
  private batchDepth = 0;

  constructor(
    memento: vscode.Memento,
    onStateChange: (state: ConversationState) => void,
    options: ConversationStoreOptions = {},
  ) {
    this.onStateChange = onStateChange;
    this.repository = new ConversationRepository(memento);

    const saved = this.repository.load();
    const initialState: PersistedConversationState = {
      currentConversationId: saved?.currentId || null,
      conversations: saved?.conversations || [],
    };

    this.runtimeStateStore = new RuntimeStateStore(saved);
    this.conversationService = new ConversationService(initialState, {
      onPersist: () => this.persist(),
      onChange: () => this.notifyChange(),
    });
  }

  getState(): ConversationState {
    const current = this.getCurrentConversation();
    const runtime = this.runtimeStateStore.getSnapshot();
    const persisted = this.conversationService.getPersistedState();
    return {
      ...persisted,
      ...runtime,
      contextUsage: this.resolveContextUsage(current),
    };
  }

  getCurrentConversation(): Conversation | null {
    return this.conversationService.getCurrentConversation();
  }

  setCliStatus(
    available: boolean,
    version: string | null,
    diagnostics?: string,
  ): void {
    this.runtimeStateStore.setCliStatus(available, version, diagnostics);
    this.notifyChange();
  }

  setWorkspaceFolders(folders: Array<{ uri: string; name: string }>): void {
    this.runtimeStateStore.setWorkspaceFolders(folders);
    this.notifyChange();
  }

  setConversationWorkspaceFolder(uri: string): void {
    this.conversationService.setConversationWorkspaceFolder(uri);
  }

  setStreaming(streaming: boolean): void {
    this.runtimeStateStore.setStreaming(streaming);
    this.notifyChange();
  }

  newConversation(workspaceFolderUri?: string): Conversation {
    return this.conversationService.newConversation(workspaceFolderUri);
  }

  switchConversation(conversationId: string): void {
    this.conversationService.switchConversation(conversationId);
  }

  deleteConversation(conversationId: string): void {
    this.conversationService.deleteConversation(conversationId);
  }

  clearCurrentConversation(): void {
    this.conversationService.clearCurrentConversation();
  }

  setMode(mode: ConversationMode): void {
    this.conversationService.setMode(mode);
  }

  setThink(enabled: boolean): void {
    this.conversationService.setThink(enabled);
  }

  setModel(model: ModelType): void {
    this.conversationService.setModel(model);
  }

  setSessionId(sessionId: string): void {
    this.conversationService.setSessionId(sessionId);
  }

  clearSessionId(): void {
    this.conversationService.clearSessionId();
  }

  addUserMessage(content: string, attachedFiles: AttachedFile[]): Message {
    return this.conversationService.addUserMessage(content, attachedFiles);
  }

  startAssistantMessage(): Message {
    return this.conversationService.startAssistantMessage();
  }

  appendToAssistantMessage(
    chunk: StreamChunk,
    options: AppendAssistantOptions = {},
  ): void {
    this.conversationService.appendToAssistantMessage(chunk, options);
  }

  publishState(): void {
    this.conversationService.publishState();
  }

  endAssistantMessage(): void {
    this.conversationService.endAssistantMessage();
  }

  batchUpdate(fn: () => void): void {
    this.batchDepth += 1;
    try {
      this.conversationService.batchUpdate(fn);
    } finally {
      this.batchDepth = Math.max(0, this.batchDepth - 1);
    }
    if (this.batchDepth === 0) {
      this.notifyChange();
    }
  }

  private persist(): void {
    const persistedState = this.conversationService.getPersistedState();
    const payload: SavedConversationState = {
      conversations: persistedState.conversations,
      currentId: persistedState.currentConversationId,
    };
    this.repository.save(payload);
  }

  private notifyChange(): void {
    if (this.batchDepth === 0) {
      this.onStateChange(this.getState());
    }
  }

  private resolveContextUsage(conversation: Conversation | null): ContextUsage {
    return this.conversationService.resolveContextUsage(conversation);
  }
}
