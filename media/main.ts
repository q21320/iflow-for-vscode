// Webview entry point for IFlow panel.
// Orchestrates state, message routing, and delegates rendering/events.

import type {
  Conversation,
  ConversationState,
  WebviewMessage,
  ExtensionMessage,
  IDEContext,
  RoundFileChangeSummary,
} from '../src/protocol';
import { formatStreamStatusText, StreamStatusSnapshot } from '../src/streamStatusUtils';
import { escapeHtml } from './markdownRenderer';
import { SlashMenuController } from './slashMenuController';
import { InputController } from './inputController';
import { AppMessageRouter } from './appMessageRouter';
import { TEXTAREA_MIN_HEIGHT, TEXTAREA_MAX_HEIGHT, COMPOSER_MIN_INSET, COMPOSER_INSET_PADDING } from './webviewUtils';
import {
  renderTopBar,
  renderConversationPanel,
  renderMessages,
  renderComposer,
  renderIDEContextChips,
} from './appRenderer';
import type { PendingConfirmation, PendingQuestion, PendingPlanApproval } from './panels/panelTypes';
import {
  attachTopBarListeners,
  attachModeListeners,
  attachComposerListeners,
  attachContentListeners,
  attachFileOpenListeners,
  attachIDEContextListeners,
  closePanelsOnOutsideClick,
} from './eventBinder';
import type { AppHost } from './eventBinder';
import { performFullRender } from './renderCoordinator';
import {
  updateComposerStatusBarView,
  updateIDEContextChipsView,
  updatePendingIndicatorView,
  updateStreamingContentView,
} from './streamingViewUpdater';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Main app class
class IFlowApp implements AppHost {
  private vscode: VsCodeApi;
  private state: ConversationState | null = null;
  private slashMenu!: SlashMenuController;
  private inputCtrl!: InputController;
  private faviconUri: string;
  private readonly messageRouter: AppMessageRouter;

  private composerResizeObserver: ResizeObserver | null = null;
  private pendingConfirmation: PendingConfirmation | null = null;
  private pendingQuestion: PendingQuestion | null = null;
  private pendingPlanApproval: PendingPlanApproval | null = null;
  private streamStatus: StreamStatusSnapshot | null = null;
  private clearInputOnNextRender = false;
  private ideContext: IDEContext = { activeFile: null, selection: null };
  private ideContextDismissed = { activeFile: false, selection: false };
  private latestRoundChangesByConversationId = new Map<string, RoundFileChangeSummary>();

  // AppHost public state (accessed by event binders)
  showConversationPanel = false;
  conversationSearch = '';
  showModeMenu = false;

  constructor() {
    this.vscode = acquireVsCodeApi();
    this.faviconUri = document.getElementById('app')?.getAttribute('data-favicon-uri') || '';
    this.inputCtrl = new InputController({
      postMessage: (msg) => this.vscode.postMessage(msg),
      getInputElement: () => document.getElementById('message-input') as HTMLTextAreaElement | null,
      onAttachedFilesChanged: () => {
        attachFileOpenListeners((msg) => this.vscode.postMessage(msg));
        this.syncMessagesBottomInset();
      }
    });
    this.slashMenu = new SlashMenuController({
      postMessage: (msg) => this.vscode.postMessage(msg),
      getCurrentConversation: () => this.getCurrentConversation(),
      getInputElement: () => document.getElementById('message-input') as HTMLTextAreaElement | null,
      onSlashMenuClosed: () => {
        this.clearInputOnNextRender = true;
        this.render();
      },
      getWorkspaceFolders: () => this.state?.workspaceFolders ?? [],
      isMultiRoot: () => this.state?.isMultiRoot ?? false
    });
    this.messageRouter = new AppMessageRouter({
      getState: () => this.state,
      setState: (state) => {
        this.state = state;
      },
      getStreamStatus: () => this.streamStatus,
      setStreamStatus: (status) => {
        this.streamStatus = status;
      },
      getIDEContext: () => this.ideContext,
      setIDEContext: (context) => {
        this.ideContext = context;
      },
      getIDEContextDismissed: () => ({ ...this.ideContextDismissed }),
      setIDEContextDismissed: (dismissed) => {
        this.ideContextDismissed = dismissed;
      },
      getLatestRoundChangesByConversationId: () => this.latestRoundChangesByConversationId,
      setLatestRoundChangesByConversationId: (value) => {
        this.latestRoundChangesByConversationId = value;
      },
      setPendingConfirmation: (value) => {
        this.pendingConfirmation = value;
      },
      setPendingQuestion: (value) => {
        this.pendingQuestion = value;
      },
      setPendingPlanApproval: (value) => {
        this.pendingPlanApproval = value;
      },
      inputCtrl: this.inputCtrl,
      render: (conversationChanged = false) => {
        if (conversationChanged) {
          this.clearInputOnNextRender = true;
        }
        this.render(conversationChanged);
      },
      updateStreamingContent: () => this.updateStreamingContent(),
      updatePendingIndicator: () => this.updatePendingIndicator(),
      updateIDEContextChips: () => this.updateIDEContextChips(),
    });
    this.setupMessageHandler();
    this.setupDocumentClickHandler();
    this.render();
    this.vscode.postMessage({ type: 'ready' });
  }

  // ── AppHost implementation ─────────────────────────────────────────

  postMessage(msg: WebviewMessage): void {
    this.vscode.postMessage(msg);
  }

  getConversations(): Conversation[] {
    return this.state?.conversations || [];
  }

  getCurrentConversationId(): string | null {
    return this.state?.currentConversationId ?? null;
  }

  getCurrentConversation(): Conversation | null {
    if (!this.state?.currentConversationId) return null;
    return this.state.conversations.find(c => c.id === this.state?.currentConversationId) || null;
  }

  private getWorkspaceFolderName(conversation: Conversation | null): string | undefined {
    if (!conversation?.workspaceFolderUri || !this.state?.workspaceFolders) {
      return undefined;
    }
    return this.state.workspaceFolders.find(
      f => f.uri === conversation.workspaceFolderUri
    )?.name;
  }

  getPendingConfirmation(): PendingConfirmation | null {
    return this.pendingConfirmation;
  }

  clearPendingConfirmation(): void {
    this.pendingConfirmation = null;
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.pendingQuestion;
  }

  clearPendingQuestion(): void {
    this.pendingQuestion = null;
  }

  getPendingPlanApproval(): PendingPlanApproval | null {
    return this.pendingPlanApproval;
  }

  clearPendingPlanApproval(): void {
    this.pendingPlanApproval = null;
  }

  dismissIDEContext(type: 'activeFile' | 'selection'): void {
    this.ideContextDismissed = { ...this.ideContextDismissed, [type]: true };
  }

  autoSizeSelect(select: HTMLSelectElement): void {
    const option = select.options[select.selectedIndex];
    if (!option) return;
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;font-size:inherit;font-family:inherit;white-space:nowrap;';
    select.parentElement?.appendChild(span);
    span.textContent = option.text;
    select.style.width = (span.offsetWidth + 24) + 'px';
    span.remove();
  }

  handleInputChange(input: HTMLTextAreaElement): void {
    const value = input.value;
    const cursorPos = input.selectionStart;
    if (this.slashMenu.handleInput(value)) { return; }
    this.inputCtrl.handleInput(value, cursorPos);
  }

  autoResizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
    if (textarea.scrollHeight > TEXTAREA_MIN_HEIGHT) {
      textarea.style.height = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT) + 'px';
    }
    this.syncMessagesBottomInset();
  }

  slashMenuHandleKeyDown(e: KeyboardEvent): boolean {
    return this.slashMenu.handleKeyDown(e);
  }

  inputCtrlHandleEnterKey(): boolean {
    return this.inputCtrl.handleEnterKey();
  }

  inputCtrlHandleEscapeKey(): void {
    this.inputCtrl.handleEscapeKey();
  }

  sendMessage(): void {
    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    const content = input?.value.trim() || '';

    if (!this.inputCtrl.canSend(content)) { return; }

    const attachedFiles = this.inputCtrl.consumeAttachedFiles();

    // Build effective IDE context excluding dismissed items
    const ideContext: IDEContext = {
      activeFile: this.ideContextDismissed.activeFile ? null : this.ideContext.activeFile,
      selection: this.ideContextDismissed.selection ? null : this.ideContext.selection,
    };
    const hasContext = ideContext.activeFile !== null || ideContext.selection !== null;

    this.vscode.postMessage({
      type: 'sendMessage',
      content,
      attachedFiles,
      ...(hasContext ? { ideContext } : {})
    });

    // Clear input
    if (input) {
      input.value = '';
      this.autoResizeTextarea(input);
    }
  }

  // ── Message handling ───────────────────────────────────────────────

  private setupMessageHandler(): void {
    window.addEventListener('message', (event) => {
      this.handleMessage(event.data as ExtensionMessage);
    });
  }

  /** Single document-level click handler (registered once, not per-render). */
  private setupDocumentClickHandler(): void {
    document.addEventListener('click', (e) => {
      closePanelsOnOutsideClick(this, e.target);
    });
  }

  private handleMessage(message: ExtensionMessage): void {
    this.messageRouter.handle(message);
  }

  // ── Rendering orchestration ────────────────────────────────────────

  render(smoothScrollToBottom = false): void {
    const app = document.getElementById('app');
    if (!app) return;

    const clearInput = this.clearInputOnNextRender;
    this.clearInputOnNextRender = false;

    const conversation = this.getCurrentConversation();
    const roundFileChanges = conversation
      ? this.latestRoundChangesByConversationId.get(conversation.id)
      : undefined;
    const title = conversation ? escapeHtml(conversation.title) : 'No conversations';
    const conversationPanelHtml = renderConversationPanel({
      conversations: this.state?.conversations || [],
      search: this.conversationSearch,
      showPanel: this.showConversationPanel,
      currentConversationId: this.state?.currentConversationId ?? null
    });

    const html = `
      <div class="container">
        ${renderTopBar(title, conversationPanelHtml, this.showConversationPanel)}
        ${renderMessages(
          conversation,
          this.state?.isStreaming ?? false,
          this.faviconUri,
          this.getPendingIndicatorText(),
        )}
        ${renderComposer({
          conversation,
          isStreaming: this.state?.isStreaming ?? false,
          pendingConfirmation: this.pendingConfirmation,
          pendingQuestion: this.pendingQuestion,
          pendingPlanApproval: this.pendingPlanApproval,
          ideContextChipsHtml: renderIDEContextChips(this.ideContext, this.ideContextDismissed),
          attachedFilesHtml: this.inputCtrl.renderAttachedFilesHtml(),
          slashMenuHtml: this.slashMenu.isVisible ? this.slashMenu.renderHtml() : '',
          mentionMenuHtml: this.inputCtrl.isMentionVisible ? this.inputCtrl.renderMentionMenuHtml() : '',
          contextUsage: this.state?.contextUsage,
          showModeMenu: this.showModeMenu,
          workspaceFolderName: this.getWorkspaceFolderName(conversation),
          isMultiRoot: this.state?.isMultiRoot ?? false,
          roundFileChanges,
        })}
      </div>
    `;

    performFullRender({
      app,
      clearInputOnNextRender: clearInput,
      html,
      bindListeners: () => {
        attachTopBarListeners(this);
        attachModeListeners(this);
        attachComposerListeners(this);
        attachContentListeners();
        this.slashMenu.attachListeners();
        this.inputCtrl.attachMentionListeners();
        this.inputCtrl.attachFileRemoveListeners();
        attachFileOpenListeners((msg) => this.vscode.postMessage(msg));
        attachIDEContextListeners(this);
        this.setupComposerLayoutObserver();
      },
      onRestoreInput: (input) => {
        this.autoResizeTextarea(input);
      },
      onScrollToBottom: (smooth) => {
        this.scrollToBottom(smooth);
      },
      smoothScrollToBottom,
    });
  }

  /**
   * Incremental update during streaming: only update the last assistant message
   * and the pending indicator, avoiding a full DOM rebuild.
   */
  private updateStreamingContent(): void {
    updateStreamingContentView({
      conversation: this.getCurrentConversation(),
      fallbackRender: () => this.render(),
      updatePendingIndicator: (container) => this.updatePendingIndicator(container),
      updateComposerStatusBar: () => this.updateComposerStatusBar(),
      scrollToBottom: () => this.scrollToBottom(),
    });
  }

  /**
   * Incrementally update IDE context chips without a full DOM rebuild.
   */
  private updateIDEContextChips(): void {
    updateIDEContextChipsView({
      ideContext: this.ideContext,
      ideContextDismissed: this.ideContextDismissed,
      onAfterPatch: () => {
        attachIDEContextListeners(this);
        this.syncMessagesBottomInset();
      },
    });
  }

  /**
   * Incrementally patch composer status bar elements (mode label, thinking chip,
   * model select, mode popup active states) without a full DOM rebuild.
   * Existing event listeners remain intact since we only mutate text/attributes.
   */
  private updateComposerStatusBar(): void {
    updateComposerStatusBarView({
      conversation: this.getCurrentConversation(),
      showModeMenu: this.showModeMenu,
      autoSizeSelect: (select) => this.autoSizeSelect(select),
    });
  }

  private updatePendingIndicator(container?: Element): void {
    updatePendingIndicatorView({
      container,
      isStreaming: this.state?.isStreaming ?? false,
      faviconUri: this.faviconUri,
      pendingStatusText: this.getPendingIndicatorText(),
    });
  }

  private getPendingIndicatorText(): string {
    return formatStreamStatusText(this.streamStatus);
  }

  // ── Layout helpers ─────────────────────────────────────────────────

  private setupComposerLayoutObserver(): void {
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = null;

    const composer = document.querySelector('.composer') as HTMLElement | null;
    if (!composer) {
      return;
    }

    if (typeof ResizeObserver === 'undefined') {
      this.syncMessagesBottomInset();
      return;
    }

    this.composerResizeObserver = new ResizeObserver(() => {
      this.syncMessagesBottomInset();
    });
    this.composerResizeObserver.observe(composer);
    this.syncMessagesBottomInset();
  }

  private syncMessagesBottomInset(): void {
    const messages = (document.getElementById('messages-container') || document.querySelector('.messages')) as HTMLElement | null;
    const composer = document.querySelector('.composer') as HTMLElement | null;
    if (!messages || !composer) {
      return;
    }

    const inset = Math.max(COMPOSER_MIN_INSET, composer.offsetHeight + COMPOSER_INSET_PADDING);
    messages.style.paddingBottom = `${inset}px`;
  }

  private scrollToBottom(smooth = false): void {
    const container = document.getElementById('messages-container');
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto'
      });
    }
  }

  dispose(): void {
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = null;
    this.slashMenu.dispose();
    this.inputCtrl.dispose();
  }
}

// Initialize app when DOM is ready (guard against double init)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new IFlowApp());
} else {
  new IFlowApp();
}
