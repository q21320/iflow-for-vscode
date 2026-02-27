// DOM event binding functions for the IFlow webview.
// Extracted from IFlowApp to separate rendering from event attachment.

import type { ConversationMode, ModelType, Conversation, WebviewMessage } from '../src/protocol';
import { renderConversationPanel } from './appRenderer';
import type { PendingConfirmation, PendingQuestion, PendingPlanApproval } from './panels/panelTypes';
import {
  attachApprovalListeners,
  attachQuestionListeners,
  attachPlanApprovalListeners,
} from './panels/panelControllers';

function isKeyboardActivation(event: KeyboardEvent): boolean {
  return event.key === 'Enter' || event.key === ' ';
}

function bindActivation(
  element: HTMLElement,
  onActivate: (event: MouseEvent | KeyboardEvent) => void,
): void {
  element.addEventListener('click', (event) => onActivate(event));
  element.addEventListener('keydown', (event) => {
    if (!isKeyboardActivation(event)) {
      return;
    }
    event.preventDefault();
    onActivate(event);
  });
}

function closeFloatingPanel(panelId: string, triggerId: string): void {
  document.getElementById(panelId)?.classList.add('hidden');
  document.getElementById(triggerId)?.setAttribute('aria-expanded', 'false');
}

/** Interface that IFlowApp implements to supply state and actions to event binders. */
export interface AppHost {
  postMessage(msg: WebviewMessage): void;
  render(): void;
  sendMessage(): void;

  // Mutable UI state
  showConversationPanel: boolean;
  conversationSearch: string;
  showModeMenu: boolean;

  // State access
  getConversations(): Conversation[];
  getCurrentConversationId(): string | null;
  getCurrentConversation(): Conversation | null;
  getPendingConfirmation(): PendingConfirmation | null;
  clearPendingConfirmation(): void;
  getPendingQuestion(): PendingQuestion | null;
  clearPendingQuestion(): void;
  getPendingPlanApproval(): PendingPlanApproval | null;
  clearPendingPlanApproval(): void;
  dismissIDEContext(type: 'activeFile' | 'selection'): void;

  // DOM helpers
  autoSizeSelect(select: HTMLSelectElement): void;
  handleInputChange(input: HTMLTextAreaElement): void;
  autoResizeTextarea(textarea: HTMLTextAreaElement): void;

  // Controller delegates
  slashMenuHandleKeyDown(e: KeyboardEvent): boolean;
  inputCtrlHandleEnterKey(): boolean;
  inputCtrlHandleEscapeKey(): void;
}

function closeConversationPanel(host: AppHost): void {
  host.showConversationPanel = false;
  host.conversationSearch = '';
  closeFloatingPanel('conversation-panel', 'conversation-trigger');
}

function closeModeMenu(host: AppHost): void {
  host.showModeMenu = false;
  closeFloatingPanel('mode-popup', 'mode-trigger');
}

function attachConversationPanelListeners(host: AppHost): void {
  const switchConversation = (conversationId: string): void => {
    closeConversationPanel(host);
    host.postMessage({ type: 'switchConversation', conversationId });
  };

  document.querySelectorAll('.conversation-item').forEach((item) => {
    const conversationItem = item as HTMLElement;
    bindActivation(conversationItem, (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.conversation-item-delete')) {
        return;
      }
      const id = conversationItem.dataset.id;
      if (id) {
        switchConversation(id);
      }
    });
  });

  document.querySelectorAll('.conversation-item-delete').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = (btn as HTMLElement).dataset.deleteId;
      if (id) {
        host.postMessage({ type: 'deleteConversation', conversationId: id });
      }
    });
  });
}

function attachConversationSearchListeners(host: AppHost): void {
  const searchInput = document.getElementById('conversation-search') as HTMLInputElement | null;
  searchInput?.addEventListener('input', () => {
    host.conversationSearch = searchInput.value;
    const panel = document.getElementById('conversation-panel');
    if (!panel) {
      return;
    }

    panel.outerHTML = renderConversationPanel({
      conversations: host.getConversations(),
      search: host.conversationSearch,
      showPanel: true,
      currentConversationId: host.getCurrentConversationId(),
    });

    const newPanel = document.getElementById('conversation-panel');
    if (!newPanel) {
      return;
    }

    newPanel.classList.remove('hidden');
    host.showConversationPanel = true;
    attachConversationPanelListeners(host);

    const newSearch = document.getElementById('conversation-search') as HTMLInputElement | null;
    if (newSearch) {
      newSearch.focus();
      newSearch.selectionStart = newSearch.selectionEnd = newSearch.value.length;
    }
  });
}

function attachFileChangeReviewListeners(host: AppHost): void {
  document.querySelectorAll('[data-file-change-row="1"]').forEach((node) => {
    const row = node as HTMLElement;
    bindActivation(row, (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-file-change-action]')) {
        return;
      }

      const conversationId = row.dataset.fileChangeConversationId;
      const assistantMessageId = row.dataset.fileChangeAssistantId;
      const filePath = row.dataset.fileChangePath;
      if (!conversationId || !assistantMessageId || !filePath) {
        return;
      }

      host.postMessage({
        type: 'fileChangeAction',
        action: 'openDiff',
        conversationId,
        assistantMessageId,
        path: filePath,
      });
    });
  });

  document.querySelectorAll('[data-file-change-action]').forEach((node) => {
    const button = node as HTMLElement;
    if (button.dataset.fileChangeBound === '1') {
      return;
    }
    button.dataset.fileChangeBound = '1';

    button.addEventListener('click', (event) => {
      event.stopPropagation();

      const action = button.dataset.fileChangeAction as 'approve' | 'rollback' | undefined;
      const conversationId = button.dataset.fileChangeConversationId;
      const assistantMessageId = button.dataset.fileChangeAssistantId;
      const filePath = button.dataset.fileChangePath;
      if (!action || !conversationId || !assistantMessageId || !filePath) {
        return;
      }

      host.postMessage({
        type: 'fileChangeAction',
        action,
        conversationId,
        assistantMessageId,
        path: filePath,
      });
    });
  });
}

// ── Top bar ─────────────────────────────────────────────────────────

export function attachTopBarListeners(host: AppHost): void {
  document.getElementById('conversation-trigger')?.addEventListener('click', (event) => {
    event.stopPropagation();
    host.showConversationPanel = !host.showConversationPanel;
    (event.currentTarget as HTMLElement | null)?.setAttribute(
      'aria-expanded',
      host.showConversationPanel ? 'true' : 'false',
    );
    const panel = document.getElementById('conversation-panel');
    if (!panel) {
      return;
    }
    panel.classList.toggle('hidden', !host.showConversationPanel);
    if (host.showConversationPanel) {
      const searchInput = document.getElementById('conversation-search') as HTMLInputElement | null;
      searchInput?.focus();
    }
  });

  attachConversationSearchListeners(host);
  attachConversationPanelListeners(host);

  document.getElementById('new-conversation-top-btn')?.addEventListener('click', () => {
    host.postMessage({ type: 'newConversation' });
  });
}

// ── Mode / model selectors ──────────────────────────────────────────

export function attachModeListeners(host: AppHost): void {
  document.getElementById('mode-trigger')?.addEventListener('click', (event) => {
    event.stopPropagation();
    host.showModeMenu = !host.showModeMenu;
    (event.currentTarget as HTMLElement | null)?.setAttribute(
      'aria-expanded',
      host.showModeMenu ? 'true' : 'false',
    );
    const popup = document.getElementById('mode-popup');
    popup?.classList.toggle('hidden', !host.showModeMenu);
  });

  document.querySelectorAll('.mode-option[data-mode]').forEach((item) => {
    const modeOption = item as HTMLElement;
    bindActivation(modeOption, () => {
      const mode = modeOption.dataset.mode as ConversationMode;
      closeModeMenu(host);
      host.postMessage({ type: 'setMode', mode });
    });
  });

  const thinkOption = document.getElementById('think-option');
  if (thinkOption) {
    bindActivation(thinkOption, () => {
      const conversation = host.getCurrentConversation();
      host.postMessage({ type: 'setThink', enabled: !(conversation?.think ?? false) });
    });
  }

  const modelSelect = document.getElementById('model-select') as HTMLSelectElement | null;
  if (modelSelect) {
    host.autoSizeSelect(modelSelect);
    modelSelect.addEventListener('change', () => {
      host.postMessage({ type: 'setModel', model: modelSelect.value as ModelType });
      host.autoSizeSelect(modelSelect);
    });
  }
}

// ── Composer ─────────────────────────────────────────────────────────

export function attachComposerListeners(host: AppHost): void {
  attachFileChangeReviewListeners(host);

  if (host.getPendingConfirmation()) {
    attachApprovalListeners(host);
    return;
  }
  if (host.getPendingQuestion()) {
    attachQuestionListeners(host);
    return;
  }
  if (host.getPendingPlanApproval()) {
    attachPlanApprovalListeners(host);
    return;
  }

  document.getElementById('attach-btn')?.addEventListener('click', () => {
    host.postMessage({ type: 'pickFiles' });
  });
  document.getElementById('send-btn')?.addEventListener('click', () => {
    host.sendMessage();
  });
  document.getElementById('cancel-btn')?.addEventListener('click', () => {
    host.postMessage({ type: 'cancelCurrent' });
  });

  const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
  input?.addEventListener('input', () => {
    host.handleInputChange(input);
    host.autoResizeTextarea(input);
  });
  input?.addEventListener('keydown', (event) => {
    if (host.slashMenuHandleKeyDown(event)) {
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (host.inputCtrlHandleEnterKey()) {
        return;
      }
      host.sendMessage();
      return;
    }
    if (event.key === 'Escape') {
      host.inputCtrlHandleEscapeKey();
      host.render();
    }
  });
}

// ── Content listeners (copy, collapsible) ───────────────────────────

export function attachContentListeners(): void {
  const body = document.body;
  if (!body || body.dataset.contentListenersBound === '1') {
    return;
  }

  body.dataset.contentListenersBound = '1';
  body.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const copyBtn = target.closest('.copy-btn') as HTMLElement | null;
    if (copyBtn) {
      const content = copyBtn.dataset.content || '';
      void navigator.clipboard.writeText(content);
      return;
    }

    const collapsible = target.closest('[data-collapsible]') as HTMLElement | null;
    if (collapsible) {
      collapsible.nextElementSibling?.classList.toggle('collapsed');
    }
  });
}

// ── File open listeners ─────────────────────────────────────────────

export function attachFileOpenListeners(postMessage: (msg: WebviewMessage) => void): void {
  document.querySelectorAll('[data-open-file-path]').forEach((button) => {
    const element = button as HTMLElement;
    if (element.dataset.openBound === '1') {
      return;
    }
    element.dataset.openBound = '1';
    element.addEventListener('click', () => {
      const path = element.dataset.openFilePath;
      if (path) {
        postMessage({ type: 'openFile', path });
      }
    });
  });
}

// ── IDE Context listeners ────────────────────────────────────────────

export function attachIDEContextListeners(host: AppHost): void {
  document.querySelectorAll('.ide-context-dismiss').forEach((button) => {
    button.addEventListener('click', () => {
      const type = (button as HTMLElement).dataset.dismiss as 'activeFile' | 'selection' | undefined;
      if (!type) {
        return;
      }
      host.dismissIDEContext(type);
      host.render();
    });
  });
}

export function closePanelsOnOutsideClick(host: AppHost, target: EventTarget | null): void {
  const node = target as Node | null;
  if (!node) {
    return;
  }

  if (host.showConversationPanel) {
    const panel = document.getElementById('conversation-panel');
    const trigger = document.getElementById('conversation-trigger');
    if (panel && trigger && !panel.contains(node) && !trigger.contains(node)) {
      closeConversationPanel(host);
    }
  }

  if (host.showModeMenu) {
    const popup = document.getElementById('mode-popup');
    const trigger = document.getElementById('mode-trigger');
    if (popup && trigger && !popup.contains(node) && !trigger.contains(node)) {
      closeModeMenu(host);
    }
  }
}
