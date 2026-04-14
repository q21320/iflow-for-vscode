import type {
  Conversation,
  ConversationState,
  IDEContext,
  RoundFileChangeSummary,
} from "../src/protocol";
import { MODELS } from "../src/protocol";
import type { StreamStatusSnapshot } from "../src/streamStatusUtils";
import type {
  PendingConfirmation,
  PendingPlanApproval,
  PendingQuestion,
} from "./panels/panelTypes";

export type IDEContextDismissed = { activeFile: boolean; selection: boolean };

export class AppState {
  state: ConversationState | null = null;
  pendingConfirmation: PendingConfirmation | null = null;
  pendingQuestion: PendingQuestion | null = null;
  pendingPlanApproval: PendingPlanApproval | null = null;
  streamStatus: StreamStatusSnapshot | null = null;

  showConversationPanel = false;
  conversationSearch = "";
  showModeMenu = false;

  models: string[] = [...MODELS];

  ideContext: IDEContext = { activeFile: null, selection: null };
  ideContextDismissed: IDEContextDismissed = {
    activeFile: false,
    selection: false,
  };
  latestRoundChangesByConversationId = new Map<
    string,
    RoundFileChangeSummary
  >();

  clearInputOnNextRender = false;

  getConversations(): Conversation[] {
    return this.state?.conversations || [];
  }

  getCurrentConversationId(): string | null {
    return this.state?.currentConversationId ?? null;
  }

  getCurrentConversation(): Conversation | null {
    const currentId = this.state?.currentConversationId;
    if (!currentId) {
      return null;
    }
    return this.state?.conversations.find((c) => c.id === currentId) || null;
  }

  getWorkspaceFolderName(
    conversation: Conversation | null,
  ): string | undefined {
    if (!conversation?.workspaceFolderUri || !this.state?.workspaceFolders) {
      return undefined;
    }
    return this.state.workspaceFolders.find(
      (f) => f.uri === conversation.workspaceFolderUri,
    )?.name;
  }

  getCwd(conversation: Conversation | null): string | undefined {
    if (conversation?.workspaceFolderUri) {
      return conversation.workspaceFolderUri;
    }
    const folders = this.state?.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri;
    }
    return undefined;
  }

  consumeClearInputOnNextRender(): boolean {
    const value = this.clearInputOnNextRender;
    this.clearInputOnNextRender = false;
    return value;
  }

  clearRoundChangesForConversation(conversationId: string): void {
    if (!this.latestRoundChangesByConversationId.has(conversationId)) {
      return;
    }
    const next = new Map(this.latestRoundChangesByConversationId);
    next.delete(conversationId);
    this.latestRoundChangesByConversationId = next;
  }
}
