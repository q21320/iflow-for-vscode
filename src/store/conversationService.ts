import {
  AttachedFile,
  Conversation,
  ConversationMode,
  DEFAULT_CONTEXT_SIZE,
  Message,
  MODEL_CONTEXT_SIZES,
  MODELS,
  ModelType,
  StreamChunk,
} from "../protocol";
import { applyChunkToMessage } from "./chunkReducer";
import {
  updateConversationById as applyConversationUpdate,
  deriveConversationTitle,
  createConversationId,
} from "./conversationMutations";
import {
  estimateConversationContextUsage,
  ContextUsage,
} from "./contextUsageEstimator";
import {
  AppendAssistantOptions,
  PersistedConversationState,
  UsageChunk,
} from "./storeTypes";

interface ConversationServiceDependencies {
  onPersist: () => void;
  onChange: () => void;
}

export class ConversationService {
  private state: PersistedConversationState;
  private batchDepth = 0;
  private readonly acpUsedTokensByConversationId = new Map<string, number>();
  private currentConvCache: {
    stateRef: PersistedConversationState;
    result: Conversation | null;
  } | null = null;

  constructor(
    initialState: PersistedConversationState,
    private readonly deps: ConversationServiceDependencies,
  ) {
    this.state = initialState;
  }

  getPersistedState(): PersistedConversationState {
    return this.state;
  }

  getCurrentConversation(): Conversation | null {
    if (
      this.currentConvCache &&
      this.currentConvCache.stateRef === this.state
    ) {
      return this.currentConvCache.result;
    }
    if (!this.state.currentConversationId) {
      this.currentConvCache = { stateRef: this.state, result: null };
      return null;
    }
    const result =
      this.state.conversations.find(
        (c) => c.id === this.state.currentConversationId,
      ) || null;
    this.currentConvCache = { stateRef: this.state, result };
    return result;
  }

  setConversationWorkspaceFolder(uri: string): void {
    const updated = this.updateCurrentConversation((conversation) => ({
      ...conversation,
      workspaceFolderUri: uri,
      updatedAt: Date.now(),
    }));
    if (updated) {
      this.persistAndNotify();
    }
  }

  newConversation(workspaceFolderUri?: string): Conversation {
    const current = this.getCurrentConversation();
    const conversation: Conversation = {
      id: createConversationId(),
      title: "New Conversation",
      messages: [],
      mode: "default",
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
    this.persistAndNotify();
    return conversation;
  }

  switchConversation(conversationId: string): void {
    const conversation = this.state.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!conversation) {
      return;
    }

    this.state = { ...this.state, currentConversationId: conversationId };
    this.persistAndNotify();
  }

  deleteConversation(conversationId: string): void {
    const index = this.state.conversations.findIndex(
      (c) => c.id === conversationId,
    );
    if (index === -1) {
      return;
    }
    this.acpUsedTokensByConversationId.delete(conversationId);

    const conversations = this.state.conversations.filter(
      (c) => c.id !== conversationId,
    );
    const currentConversationId =
      this.state.currentConversationId === conversationId
        ? conversations[0]?.id || null
        : this.state.currentConversationId;

    this.state = {
      ...this.state,
      conversations,
      currentConversationId,
    };
    this.persistAndNotify();
  }

  clearCurrentConversation(): void {
    const currentConversationId = this.state.currentConversationId;
    if (currentConversationId) {
      this.acpUsedTokensByConversationId.delete(currentConversationId);
    }

    const updated = this.updateCurrentConversation((conversation) => ({
      ...conversation,
      messages: [],
      title: "New Conversation",
      sessionId: undefined,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.persistAndNotify();
    }
  }

  setMode(mode: ConversationMode): void {
    const conversation =
      this.getCurrentConversation() ?? this.newConversation();
    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      mode,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.persistAndNotify();
    }
  }

  setThink(enabled: boolean): void {
    const conversation =
      this.getCurrentConversation() ?? this.newConversation();
    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      think: enabled,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.persistAndNotify();
    }
  }

  setModel(model: ModelType): void {
    const conversation =
      this.getCurrentConversation() ?? this.newConversation();
    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      model,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.persistAndNotify();
    }
  }

  setSessionId(sessionId: string): void {
    const updated = this.updateCurrentConversation((conversation) => ({
      ...conversation,
      sessionId,
    }));

    if (updated) {
      this.persistAndNotify();
    }
  }

  clearSessionId(): void {
    const updated = this.updateCurrentConversation((conversation) => ({
      ...conversation,
      sessionId: undefined,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.persistAndNotify();
    }
  }

  addUserMessage(content: string, attachedFiles: AttachedFile[]): Message {
    let conversation = this.getCurrentConversation();
    if (!conversation) {
      conversation = this.newConversation();
    }

    const message: Message = {
      id: createConversationId(),
      role: "user",
      content,
      blocks: [{ type: "text", content }],
      attachedFiles,
      timestamp: Date.now(),
    };

    const userCount =
      conversation.messages.filter((m) => m.role === "user").length + 1;
    const nextTitle =
      userCount === 1 ? deriveConversationTitle(content) : conversation.title;

    const updated = this.updateConversationById(conversation.id, (current) => ({
      ...current,
      messages: [...current.messages, message],
      title: nextTitle,
      updatedAt: Date.now(),
    }));

    if (updated) {
      this.persistAndNotify();
    }

    return message;
  }

  startAssistantMessage(): Message {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      throw new Error("No current conversation");
    }

    const message: Message = {
      id: createConversationId(),
      role: "assistant",
      content: "",
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

  appendToAssistantMessage(
    chunk: StreamChunk,
    options: AppendAssistantOptions = {},
  ): void {
    const shouldNotify = options.notify ?? true;
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      return;
    }

    if (chunk.chunkType === "usage") {
      if (this.updateAcpUsage(conversation, chunk)) {
        if (shouldNotify) {
          this.notifyChange();
        }
      }
      return;
    }

    const lastIndex = conversation.messages.length - 1;
    const lastMessage = conversation.messages[lastIndex];
    if (!lastMessage || lastMessage.role !== "assistant") {
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
    if (!lastMessage || lastMessage.role !== "assistant") {
      return;
    }

    const collapsedBlocks = lastMessage.blocks.map((block) =>
      block.type === "thinking" ? { ...block, collapsed: true } : block,
    );

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
      this.persistAndNotify();
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

  resolveContextUsage(conversation: Conversation | null): ContextUsage {
    if (!conversation) {
      return { usedTokens: 0, totalTokens: DEFAULT_CONTEXT_SIZE, percent: 0 };
    }

    const acpUsedTokens = this.acpUsedTokensByConversationId.get(
      conversation.id,
    );
    if (acpUsedTokens === undefined) {
      return estimateConversationContextUsage(conversation);
    }

    const totalTokens =
      MODEL_CONTEXT_SIZES[conversation.model] || DEFAULT_CONTEXT_SIZE;
    const percent =
      totalTokens > 0
        ? Math.min(100, Math.round((acpUsedTokens / totalTokens) * 100))
        : 0;
    return {
      usedTokens: acpUsedTokens,
      totalTokens,
      percent,
    };
  }

  private persist(): void {
    this.deps.onPersist();
  }

  private notifyChange(): void {
    if (this.batchDepth === 0) {
      this.deps.onChange();
    }
  }

  private persistAndNotify(): void {
    this.persist();
    this.notifyChange();
  }

  private updateCurrentConversation(
    updater: (conversation: Conversation) => Conversation,
  ): Conversation | null {
    if (!this.state.currentConversationId) {
      return null;
    }
    return this.updateConversationById(
      this.state.currentConversationId,
      updater,
    );
  }

  private updateConversationById(
    conversationId: string,
    updater: (conversation: Conversation) => Conversation,
  ): Conversation | null {
    const { nextState, updatedConversation } = applyConversationUpdate(
      this.state,
      conversationId,
      updater,
    );
    this.state = nextState;
    return updatedConversation;
  }

  private updateAcpUsage(
    conversation: Conversation,
    chunk: UsageChunk,
  ): boolean {
    const usedTokens =
      chunk.promptTokens ?? chunk.totalTokens ?? chunk.completionTokens;
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
