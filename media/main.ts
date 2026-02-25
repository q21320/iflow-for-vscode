// Webview entry point for IFlow panel.
// Orchestrates state, message routing, and delegates rendering/events.

import type {
  Conversation,
  ConversationState,
  WebviewMessage,
  ExtensionMessage,
  IDEContext,
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
  renderBlock,
  renderPendingIndicator,
  renderIDEContextChips,
  getModeLabel,
} from './appRenderer';
import type { PendingConfirmation, PendingQuestion, PendingPlanApproval } from './panels/panelTypes';
import {
  attachTopBarListeners,
  attachModeListeners,
  attachComposerListeners,
  attachContentListeners,
  attachFileOpenListeners,
  attachIDEContextListeners,
} from './eventBinder';
import type { AppHost } from './eventBinder';

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
      // Close conversation panel on outside click
      if (this.showConversationPanel) {
        const panel = document.getElementById('conversation-panel');
        const trigger = document.getElementById('conversation-trigger');
        if (panel && trigger && !panel.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
          this.showConversationPanel = false;
          panel.classList.add('hidden');
          trigger.setAttribute('aria-expanded', 'false');
        }
      }
      // Close mode popup on outside click
      if (this.showModeMenu) {
        const popup = document.getElementById('mode-popup');
        const trigger = document.getElementById('mode-trigger');
        if (popup && trigger && !popup.contains(e.target as Node) && !trigger.contains(e.target as Node)) {
          this.showModeMenu = false;
          popup.classList.add('hidden');
          trigger.setAttribute('aria-expanded', 'false');
        }
      }
    });
  }

  private handleMessage(message: ExtensionMessage): void {
    this.messageRouter.handle(message);
  }

  // ── Rendering orchestration ────────────────────────────────────────

  render(smoothScrollToBottom = false): void {
    const app = document.getElementById('app');
    if (!app) return;

    // Save current input state before DOM rebuild
    const prevInput = document.getElementById('message-input') as HTMLTextAreaElement;
    const savedValue = this.clearInputOnNextRender ? '' : (prevInput?.value ?? '');
    const savedSelStart = prevInput?.selectionStart ?? 0;
    const savedSelEnd = prevInput?.selectionEnd ?? 0;
    this.clearInputOnNextRender = false;

    // Hide during DOM rebuild to prevent visible scroll-from-top flash
    app.style.visibility = 'hidden';

    const conversation = this.getCurrentConversation();
    const title = conversation ? escapeHtml(conversation.title) : 'No conversations';

    const conversationPanelHtml = renderConversationPanel({
      conversations: this.state?.conversations || [],
      search: this.conversationSearch,
      showPanel: this.showConversationPanel,
      currentConversationId: this.state?.currentConversationId ?? null
    });

    app.innerHTML = `
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
          isMultiRoot: this.state?.isMultiRoot ?? false
        })}
      </div>
    `;

    // Attach event listeners
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

    // Restore input state after DOM rebuild
    if (savedValue) {
      const newInput = document.getElementById('message-input') as HTMLTextAreaElement;
      if (newInput) {
        newInput.value = savedValue;
        newInput.selectionStart = savedSelStart;
        newInput.selectionEnd = savedSelEnd;
        this.autoResizeTextarea(newInput);
      }
    }

    this.scrollToBottom(smoothScrollToBottom);

    // Restore visibility after scroll position is set
    requestAnimationFrame(() => {
      app.style.visibility = 'visible';
    });
  }

  /**
   * Incremental update during streaming: only update the last assistant message
   * and the pending indicator, avoiding a full DOM rebuild.
   */
  private updateStreamingContent(): void {
    const conversation = this.getCurrentConversation();
    if (!conversation) {
      this.render();
      return;
    }

    const container = document.getElementById('messages-container');
    if (!container) {
      this.render();
      return;
    }

    const messages = conversation.messages;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') {
      this.render();
      return;
    }

    // Update the last assistant message content
    const msgElements = container.querySelectorAll('.message');
    const lastMsgEl = msgElements[msgElements.length - 1];
    if (!lastMsgEl || !lastMsgEl.classList.contains('assistant')) {
      this.render();
      return;
    }

    const contentEl = lastMsgEl.querySelector('.message-content');
    if (contentEl) {
      contentEl.innerHTML = lastMsg.blocks.map(b => renderBlock(b)).join('');
    }

    // Update pending indicator
    this.updatePendingIndicator(container);

    // Incrementally update composer status bar (mode label, thinking chip, model)
    this.updateComposerStatusBar();

    this.scrollToBottom();
  }

  /**
   * Incrementally update IDE context chips without a full DOM rebuild.
   */
  private updateIDEContextChips(): void {
    const existing = document.getElementById('ide-context-chips');
    const newHtml = renderIDEContextChips(this.ideContext, this.ideContextDismissed);
    if (existing) {
      existing.outerHTML = newHtml;
    } else if (newHtml) {
      const composer = document.querySelector('.composer');
      if (composer) {
        composer.insertAdjacentHTML('afterbegin', newHtml);
      }
    }
    attachIDEContextListeners(this);
    this.syncMessagesBottomInset();
  }

  /**
   * Incrementally patch composer status bar elements (mode label, thinking chip,
   * model select, mode popup active states) without a full DOM rebuild.
   * Existing event listeners remain intact since we only mutate text/attributes.
   */
  private updateComposerStatusBar(): void {
    const conversation = this.getCurrentConversation();
    const mode = conversation?.mode || 'default';
    const isThinking = conversation?.think ?? false;
    const currentModel = conversation?.model ?? 'GLM-4.7';

    // 1. Update mode trigger label
    const modeTrigger = document.getElementById('mode-trigger');
    if (modeTrigger) {
      const labelSpan = modeTrigger.querySelector('span:first-child');
      if (labelSpan) {
        labelSpan.textContent = getModeLabel(mode);
      }
      modeTrigger.setAttribute('aria-expanded', this.showModeMenu ? 'true' : 'false');
    }

    // 2. Update mode popup active states
    document.querySelectorAll('.mode-option[data-mode]').forEach(el => {
      const optionMode = (el as HTMLElement).dataset.mode;
      el.classList.toggle('active', optionMode === mode);
      el.setAttribute('aria-selected', optionMode === mode ? 'true' : 'false');
    });

    // 3. Update thinking toggle switch
    const toggleSwitch = document.querySelector('#think-option .toggle-switch');
    if (toggleSwitch) {
      toggleSwitch.classList.toggle('active', isThinking);
    }
    const thinkOption = document.getElementById('think-option');
    if (thinkOption) {
      thinkOption.setAttribute('aria-pressed', isThinking ? 'true' : 'false');
    }

    // 4. Update thinking chip (add/remove)
    const statusLeft = document.querySelector('.status-left');
    const existingChip = document.querySelector('.thinking-chip');
    if (isThinking && !existingChip && statusLeft) {
      const modelItem = document.getElementById('model-select')?.closest('.status-item');
      if (modelItem) {
        modelItem.insertAdjacentHTML('beforebegin', '<span class="thinking-chip">🧠 Thinking</span>');
      }
    } else if (!isThinking && existingChip) {
      existingChip.remove();
    }

    // 5. Update model select value
    const modelSelect = document.getElementById('model-select') as HTMLSelectElement | null;
    if (modelSelect && modelSelect.value !== currentModel) {
      modelSelect.value = currentModel;
      this.autoSizeSelect(modelSelect);
    }
  }

  private updatePendingIndicator(container?: Element): void {
    const target = container ?? document.getElementById('messages-container');
    if (!target) {
      return;
    }

    const existingIndicator = target.querySelector('.pending-indicator');
    if (this.state?.isStreaming) {
      const indicatorHtml = renderPendingIndicator(this.faviconUri, this.getPendingIndicatorText());
      if (existingIndicator) {
        (existingIndicator as HTMLElement).outerHTML = indicatorHtml;
      } else {
        target.insertAdjacentHTML('beforeend', indicatorHtml);
      }
      return;
    }

    existingIndicator?.remove();
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
