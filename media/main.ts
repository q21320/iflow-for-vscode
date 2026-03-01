// Webview entry point for IFlow panel.
// Orchestrates state, message routing, and delegates rendering/events.

import type {
  Conversation,
  WebviewMessage,
  ExtensionMessage,
  IDEContext,
} from '../src/protocol';
import { formatStreamStatusText } from '../src/streamStatusUtils';
import { formatSubagentProgressText, SubagentProgressTracker } from '../src/shared/subagentProgressTracker';
import { escapeHtml } from './markdownRenderer';
import { SlashMenuController } from './slashMenuController';
import { InputController } from './inputController';
import { AppMessageRouter } from './appMessageRouter';
import {
  TEXTAREA_MIN_HEIGHT,
  TEXTAREA_MAX_HEIGHT,
  COMPOSER_MIN_INSET,
  COMPOSER_INSET_PADDING,
} from './webviewUtils';
import {
  renderTopBar,
  renderConversationPanel,
  renderMessages,
  renderComposer,
  renderIDEContextChips,
  renderRoundFileChanges,
} from './appRenderer';
import type { PendingConfirmation, PendingQuestion, PendingPlanApproval } from './panels/panelTypes';
import {
  attachTopBarListeners,
  attachModeListeners,
  attachComposerListeners,
  attachFileChangeReviewListeners,
  attachContentListeners,
  attachFileOpenListeners,
  attachIDEContextListeners,
  closePanelsOnOutsideClick,
} from './eventBinder';
import type { AppHost } from './eventBinder';
import { createStringTemplateRenderDriver, type WebviewRenderDriver } from './renderDriver';
import {
  updateComposerStatusBarView,
  updateIDEContextChipsView,
  updatePendingIndicatorView,
  updateStreamingContentView,
} from './streamingViewUpdater';
import { VisualUpdateScheduler } from '../src/shared/visualUpdateScheduler';
import { AppState } from './appState';
import { AppLifecycle } from './appLifecycle';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const STREAM_AUTO_SCROLL_THRESHOLD_PX = 120;
const SUBAGENT_PENDING_TICK_MS = 1000;

class IFlowApp implements AppHost {
  private readonly vscode: VsCodeApi;
  private readonly appState = new AppState();
  private slashMenu!: SlashMenuController;
  private inputCtrl!: InputController;
  private readonly faviconUri: string;
  private readonly messageRouter: AppMessageRouter;
  private readonly visualUpdateScheduler: VisualUpdateScheduler;
  private readonly renderDriver: WebviewRenderDriver;
  private readonly lifecycle = new AppLifecycle();
  private readonly subagentProgressTracker = new SubagentProgressTracker();
  private subagentPendingTicker: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.vscode = acquireVsCodeApi();
    this.faviconUri = document.getElementById('app')?.getAttribute('data-favicon-uri') || '';
    this.renderDriver = createStringTemplateRenderDriver();
    this.visualUpdateScheduler = new VisualUpdateScheduler(
      (run) => window.requestAnimationFrame(() => run()),
      (token) => window.cancelAnimationFrame(token),
      {
        onStreamingUpdate: () => this.applyStreamingContentUpdate(),
        onPendingIndicatorUpdate: () => this.applyPendingIndicatorUpdate(),
      },
    );

    this.inputCtrl = new InputController({
      postMessage: (msg) => this.vscode.postMessage(msg),
      getInputElement: () => document.getElementById('message-input') as HTMLTextAreaElement | null,
      onAttachedFilesChanged: () => {
        attachFileOpenListeners((msg) => this.vscode.postMessage(msg));
        this.syncMessagesBottomInset();
      },
    });

    this.slashMenu = new SlashMenuController({
      postMessage: (msg) => this.vscode.postMessage(msg),
      getCurrentConversation: () => this.getCurrentConversation(),
      getInputElement: () => document.getElementById('message-input') as HTMLTextAreaElement | null,
      onSlashMenuClosed: () => {
        this.appState.clearInputOnNextRender = true;
        this.render();
      },
      getWorkspaceFolders: () => this.appState.state?.workspaceFolders ?? [],
      isMultiRoot: () => this.appState.state?.isMultiRoot ?? false,
    });

    this.messageRouter = new AppMessageRouter({
      getState: () => this.appState.state,
      setState: (state) => {
        this.appState.state = state;
      },
      getStreamStatus: () => this.appState.streamStatus,
      setStreamStatus: (status) => {
        this.appState.streamStatus = status;
      },
      getIDEContext: () => this.appState.ideContext,
      setIDEContext: (context) => {
        this.appState.ideContext = context;
      },
      getIDEContextDismissed: () => ({ ...this.appState.ideContextDismissed }),
      setIDEContextDismissed: (dismissed) => {
        this.appState.ideContextDismissed = dismissed;
      },
      getLatestRoundChangesByConversationId: () => this.appState.latestRoundChangesByConversationId,
      setLatestRoundChangesByConversationId: (value) => {
        this.appState.latestRoundChangesByConversationId = value;
      },
      setPendingConfirmation: (value) => {
        this.appState.pendingConfirmation = value;
      },
      setPendingQuestion: (value) => {
        this.appState.pendingQuestion = value;
      },
      setPendingPlanApproval: (value) => {
        this.appState.pendingPlanApproval = value;
      },
      inputCtrl: this.inputCtrl,
      render: (conversationChanged = false) => {
        if (conversationChanged) {
          this.appState.clearInputOnNextRender = true;
        }
        this.render(conversationChanged);
      },
      updateRoundFileChanges: () => this.updateRoundFileChangesCard(),
      updateStreamingContent: () => this.scheduleStreamingContentUpdate(),
      updatePendingIndicator: () => this.schedulePendingIndicatorUpdate(),
      updateIDEContextChips: () => this.updateIDEContextChips(),
    });

    this.lifecycle.setupMessageHandler((message) => this.handleMessage(message));
    this.lifecycle.setupDocumentClickHandler((target) => {
      closePanelsOnOutsideClick(this, target);
    });

    this.render();
    this.vscode.postMessage({ type: 'ready' });
  }

  get showConversationPanel(): boolean {
    return this.appState.showConversationPanel;
  }

  set showConversationPanel(value: boolean) {
    this.appState.showConversationPanel = value;
  }

  get conversationSearch(): string {
    return this.appState.conversationSearch;
  }

  set conversationSearch(value: string) {
    this.appState.conversationSearch = value;
  }

  get showModeMenu(): boolean {
    return this.appState.showModeMenu;
  }

  set showModeMenu(value: boolean) {
    this.appState.showModeMenu = value;
  }

  postMessage(msg: WebviewMessage): void {
    this.vscode.postMessage(msg);
  }

  getConversations(): Conversation[] {
    return this.appState.getConversations();
  }

  getCurrentConversationId(): string | null {
    return this.appState.getCurrentConversationId();
  }

  getCurrentConversation(): Conversation | null {
    return this.appState.getCurrentConversation();
  }

  getPendingConfirmation(): PendingConfirmation | null {
    return this.appState.pendingConfirmation;
  }

  clearPendingConfirmation(): void {
    this.appState.pendingConfirmation = null;
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.appState.pendingQuestion;
  }

  clearPendingQuestion(): void {
    this.appState.pendingQuestion = null;
  }

  getPendingPlanApproval(): PendingPlanApproval | null {
    return this.appState.pendingPlanApproval;
  }

  clearPendingPlanApproval(): void {
    this.appState.pendingPlanApproval = null;
  }

  dismissIDEContext(type: 'activeFile' | 'selection'): void {
    this.appState.ideContextDismissed = { ...this.appState.ideContextDismissed, [type]: true };
  }

  patchIDEContextChips(): void {
    this.updateIDEContextChips();
  }

  autoSizeSelect(select: HTMLSelectElement): void {
    const option = select.options[select.selectedIndex];
    if (!option) return;
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;font-size:inherit;font-family:inherit;white-space:nowrap;';
    select.parentElement?.appendChild(span);
    span.textContent = option.text;
    select.style.width = `${span.offsetWidth + 24}px`;
    span.remove();
  }

  handleInputChange(input: HTMLTextAreaElement): void {
    const value = input.value;
    const cursorPos = input.selectionStart;
    if (this.slashMenu.handleInput(value)) {
      return;
    }
    this.inputCtrl.handleInput(value, cursorPos);
  }

  autoResizeTextarea(textarea: HTMLTextAreaElement): void {
    textarea.style.height = `${TEXTAREA_MIN_HEIGHT}px`;
    if (textarea.scrollHeight > TEXTAREA_MIN_HEIGHT) {
      textarea.style.height = `${Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
    }
    this.syncMessagesBottomInset();
  }

  slashMenuHandleKeyDown(e: KeyboardEvent): boolean {
    return this.slashMenu.handleKeyDown(e);
  }

  inputCtrlHandleEnterKey(): boolean {
    return this.inputCtrl.handleEnterKey();
  }

  inputCtrlHandleEscapeKey(): boolean {
    return this.inputCtrl.handleEscapeKey();
  }

  sendMessage(): void {
    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    const content = input?.value.trim() || '';

    if (!this.inputCtrl.canSend(content)) {
      return;
    }

    const attachedFiles = this.inputCtrl.consumeAttachedFiles();
    const ideContext: IDEContext = {
      activeFile: this.appState.ideContextDismissed.activeFile ? null : this.appState.ideContext.activeFile,
      selection: this.appState.ideContextDismissed.selection ? null : this.appState.ideContext.selection,
    };
    const hasContext = ideContext.activeFile !== null || ideContext.selection !== null;
    const conversationId = this.appState.state?.currentConversationId;

    if (conversationId) {
      this.appState.clearRoundChangesForConversation(conversationId);
      document.querySelector('.round-file-changes-card')?.remove();
    }

    this.vscode.postMessage({
      type: 'sendMessage',
      content,
      attachedFiles,
      ...(hasContext ? { ideContext } : {}),
    });

    if (input) {
      input.value = '';
      this.autoResizeTextarea(input);
    }
  }

  private handleMessage(message: ExtensionMessage): void {
    this.updateSubagentProgress(message);
    this.messageRouter.handle(message);
    this.syncSubagentPendingTicker();
  }

  render(smoothScrollToBottom = false): void {
    const app = document.getElementById('app');
    if (!app) {
      return;
    }

    this.visualUpdateScheduler.cancelAll();

    const clearInput = this.appState.consumeClearInputOnNextRender();
    const conversation = this.getCurrentConversation();
    const roundFileChanges = conversation
      ? this.appState.latestRoundChangesByConversationId.get(conversation.id)
      : undefined;
    const title = conversation ? escapeHtml(conversation.title) : 'No conversations';
    const conversationPanelHtml = renderConversationPanel({
      conversations: this.appState.state?.conversations || [],
      search: this.appState.conversationSearch,
      showPanel: this.appState.showConversationPanel,
      currentConversationId: this.appState.state?.currentConversationId ?? null,
    });

    const html = `
      <div class="container">
        ${renderTopBar(title, conversationPanelHtml, this.appState.showConversationPanel)}
        ${renderMessages(
          conversation,
          this.appState.state?.isStreaming ?? false,
          this.faviconUri,
          this.getPendingIndicatorText(),
        )}
        ${renderComposer({
          conversation,
          isStreaming: this.appState.state?.isStreaming ?? false,
          pendingConfirmation: this.appState.pendingConfirmation,
          pendingQuestion: this.appState.pendingQuestion,
          pendingPlanApproval: this.appState.pendingPlanApproval,
          ideContextChipsHtml: renderIDEContextChips(this.appState.ideContext, this.appState.ideContextDismissed),
          attachedFilesHtml: this.inputCtrl.renderAttachedFilesHtml(),
          slashMenuHtml: this.slashMenu.isVisible ? this.slashMenu.renderHtml() : '',
          mentionMenuHtml: this.inputCtrl.isMentionVisible ? this.inputCtrl.renderMentionMenuHtml() : '',
          contextUsage: this.appState.state?.contextUsage,
          showModeMenu: this.appState.showModeMenu,
          workspaceFolderName: this.appState.getWorkspaceFolderName(conversation),
          isMultiRoot: this.appState.state?.isMultiRoot ?? false,
          roundFileChanges,
        })}
      </div>
    `;

    this.renderDriver.renderFull({
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

  private scheduleStreamingContentUpdate(): void {
    this.visualUpdateScheduler.scheduleStreamingUpdate();
  }

  private applyStreamingContentUpdate(): void {
    const shouldAutoScroll = this.isMessagesViewNearBottom();
    updateStreamingContentView({
      conversation: this.getCurrentConversation(),
      fallbackRender: () => this.render(),
      updatePendingIndicator: (container) => this.applyPendingIndicatorUpdate(container),
      updateComposerStatusBar: () => this.updateComposerStatusBar(),
      scrollToBottom: () => {
        if (shouldAutoScroll) {
          this.scrollToBottom();
        }
      },
    });
  }

  private updateRoundFileChangesCard(): void {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      return;
    }

    const composer = document.querySelector('.composer') as HTMLElement | null;
    if (!composer) {
      return;
    }

    const summary = this.appState.latestRoundChangesByConversationId.get(conversation.id);
    const nextHtml = renderRoundFileChanges(summary);
    const existing = composer.querySelector('.round-file-changes-card') as HTMLElement | null;

    if (!nextHtml) {
      existing?.remove();
      this.syncMessagesBottomInset();
      return;
    }

    if (existing) {
      existing.outerHTML = nextHtml;
    } else {
      composer.insertAdjacentHTML('afterbegin', nextHtml);
    }
    attachFileChangeReviewListeners(this);
    this.syncMessagesBottomInset();
  }

  private updateIDEContextChips(): void {
    updateIDEContextChipsView({
      ideContext: this.appState.ideContext,
      ideContextDismissed: this.appState.ideContextDismissed,
      onAfterPatch: () => {
        attachIDEContextListeners(this);
        this.syncMessagesBottomInset();
      },
    });
  }

  private updateComposerStatusBar(): void {
    updateComposerStatusBarView({
      conversation: this.getCurrentConversation(),
      showModeMenu: this.appState.showModeMenu,
      autoSizeSelect: (select) => this.autoSizeSelect(select),
    });
  }

  private schedulePendingIndicatorUpdate(): void {
    this.visualUpdateScheduler.schedulePendingIndicatorUpdate();
  }

  private applyPendingIndicatorUpdate(container?: Element): void {
    updatePendingIndicatorView({
      container,
      isStreaming: this.appState.state?.isStreaming ?? false,
      faviconUri: this.faviconUri,
      pendingStatusText: this.getPendingIndicatorText(),
    });
  }

  private getPendingIndicatorText(): string {
    const activeProgress = this.subagentProgressTracker.active;
    if ((this.appState.state?.isStreaming ?? false) && activeProgress) {
      return formatSubagentProgressText(activeProgress, Date.now());
    }
    return formatStreamStatusText(this.appState.streamStatus);
  }

  private updateSubagentProgress(message: ExtensionMessage): void {
    if (message.type === 'streamChunk') {
      const changed = this.subagentProgressTracker.onChunk(message.chunk);
      if (changed && (this.appState.state?.isStreaming ?? false)) {
        this.schedulePendingIndicatorUpdate();
      }
      return;
    }

    if (message.type === 'streamEnd' || message.type === 'streamError') {
      const changed = this.subagentProgressTracker.reset();
      if (changed) {
        this.schedulePendingIndicatorUpdate();
      }
      return;
    }

    if (message.type === 'stateUpdated' && !message.state.isStreaming) {
      const changed = this.subagentProgressTracker.reset();
      if (changed) {
        this.schedulePendingIndicatorUpdate();
      }
    }
  }

  private syncSubagentPendingTicker(): void {
    const shouldRunTicker = (this.appState.state?.isStreaming ?? false) && this.subagentProgressTracker.active !== null;
    if (!shouldRunTicker) {
      this.stopSubagentPendingTicker();
      return;
    }

    if (this.subagentPendingTicker) {
      return;
    }

    this.subagentPendingTicker = setInterval(() => {
      const stillStreaming = this.appState.state?.isStreaming ?? false;
      if (!stillStreaming || this.subagentProgressTracker.active === null) {
        this.stopSubagentPendingTicker();
        return;
      }
      this.schedulePendingIndicatorUpdate();
    }, SUBAGENT_PENDING_TICK_MS);
  }

  private stopSubagentPendingTicker(): void {
    if (!this.subagentPendingTicker) {
      return;
    }
    clearInterval(this.subagentPendingTicker);
    this.subagentPendingTicker = null;
  }

  private setupComposerLayoutObserver(): void {
    this.lifecycle.setupComposerLayoutObserver(() => this.syncMessagesBottomInset());
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
        behavior: smooth ? 'smooth' : 'auto',
      });
    }
  }

  private isMessagesViewNearBottom(): boolean {
    const container = document.getElementById('messages-container');
    if (!container) {
      return true;
    }

    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distanceToBottom <= STREAM_AUTO_SCROLL_THRESHOLD_PX;
  }

  dispose(): void {
    this.visualUpdateScheduler.cancelAll();
    this.stopSubagentPendingTicker();
    this.lifecycle.dispose();
    this.slashMenu.dispose();
    this.inputCtrl.dispose();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new IFlowApp());
} else {
  new IFlowApp();
}
