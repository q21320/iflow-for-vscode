// DOM event binding functions for the IFlow webview.
// Extracted from IFlowApp to separate rendering from event attachment.

import type { ConversationMode, ModelType, Conversation, WebviewMessage } from '../src/protocol';
import { renderConversationPanel } from './appRenderer';
import type { PendingConfirmation, PendingQuestion, PendingPlanApproval } from './panels/panelTypes';
import {
  attachApprovalListeners,
  attachQuestionListeners,
  attachPlanApprovalListeners,
} from './panels/panelBinders';

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

// ── Top bar ─────────────────────────────────────────────────────────

export function attachTopBarListeners(host: AppHost): void {
  document.getElementById('conversation-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    host.showConversationPanel = !host.showConversationPanel;
    const panel = document.getElementById('conversation-panel');
    if (panel) {
      panel.classList.toggle('hidden', !host.showConversationPanel);
      if (host.showConversationPanel) {
        const searchInput = document.getElementById('conversation-search') as HTMLInputElement;
        searchInput?.focus();
      }
    }
  });

  const searchInput = document.getElementById('conversation-search') as HTMLInputElement;
  searchInput?.addEventListener('input', () => {
    host.conversationSearch = searchInput.value;
    const panel = document.getElementById('conversation-panel');
    if (panel) {
      const conversations = host.getConversations();
      panel.outerHTML = renderConversationPanel({
        conversations,
        search: host.conversationSearch,
        showPanel: true,
        currentConversationId: host.getCurrentConversationId()
      });
      const newPanel = document.getElementById('conversation-panel');
      if (newPanel) {
        newPanel.classList.remove('hidden');
        host.showConversationPanel = true;
        attachConversationPanelListeners(host);
        const newSearch = document.getElementById('conversation-search') as HTMLInputElement;
        if (newSearch) {
          newSearch.focus();
          newSearch.selectionStart = newSearch.selectionEnd = newSearch.value.length;
        }
      }
    }
  });

  attachConversationPanelListeners(host);

  document.getElementById('new-conversation-top-btn')?.addEventListener('click', () => {
    host.postMessage({ type: 'newConversation' });
  });
}

// ── Mode / model selectors ──────────────────────────────────────────

export function attachModeListeners(host: AppHost): void {
  document.getElementById('mode-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    host.showModeMenu = !host.showModeMenu;
    const popup = document.getElementById('mode-popup');
    if (popup) {
      popup.classList.toggle('hidden', !host.showModeMenu);
    }
  });

  document.querySelectorAll('.mode-option[data-mode]').forEach(item => {
    item.addEventListener('click', () => {
      const mode = (item as HTMLElement).dataset.mode as ConversationMode;
      host.showModeMenu = false;
      host.postMessage({ type: 'setMode', mode });
    });
  });

  document.getElementById('think-option')?.addEventListener('click', () => {
    const conv = host.getCurrentConversation();
    const newThink = !(conv?.think ?? false);
    host.postMessage({ type: 'setThink', enabled: newThink });
  });

  const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
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
  // If the approval panel is showing, attach approval-specific listeners instead
  if (host.getPendingConfirmation()) {
    attachApprovalListeners(host);
    return;
  }

  // If the question panel is showing, attach question-specific listeners
  if (host.getPendingQuestion()) {
    attachQuestionListeners(host);
    return;
  }

  // If the plan approval panel is showing, attach plan-specific listeners
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

  const input = document.getElementById('message-input') as HTMLTextAreaElement;
  input?.addEventListener('input', () => {
    host.handleInputChange(input);
    host.autoResizeTextarea(input);
  });

  input?.addEventListener('keydown', (e) => {
    if (host.slashMenuHandleKeyDown(e)) { return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (host.inputCtrlHandleEnterKey()) { return; }
      host.sendMessage();
    } else if (e.key === 'Escape') {
      host.inputCtrlHandleEscapeKey();
      host.render();
    }
  });
}

// ── Content listeners (copy, collapsible) ───────────────────────────

export function attachContentListeners(): void {
  const body = document.body;
  if (!body) {
    return;
  }

  if (body.dataset.contentListenersBound === '1') {
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
      const content = collapsible.nextElementSibling;
      content?.classList.toggle('collapsed');
    }
  });
}

// ── File open listeners ─────────────────────────────────────────────

export function attachFileOpenListeners(postMessage: (msg: WebviewMessage) => void): void {
  document.querySelectorAll('[data-open-file-path]').forEach(btn => {
    if ((btn as HTMLElement).dataset.openBound === '1') {
      return;
    }
    (btn as HTMLElement).dataset.openBound = '1';
    btn.addEventListener('click', () => {
      const path = (btn as HTMLElement).dataset.openFilePath;
      if (!path) return;
      postMessage({ type: 'openFile', path });
    });
  });
}

// ── IDE Context listeners ────────────────────────────────────────────

export function attachIDEContextListeners(host: AppHost): void {
  document.querySelectorAll('.ide-context-dismiss').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = (btn as HTMLElement).dataset.dismiss as 'activeFile' | 'selection';
      if (type) {
        host.dismissIDEContext(type);
        host.render();
      }
    });
  });
}

// ── Conversation panel listeners ────────────────────────────────────

function attachConversationPanelListeners(host: AppHost): void {
  // Click on conversation items
  document.querySelectorAll('.conversation-item').forEach(item => {
    item.addEventListener('click', (e) => {
      // Don't switch if clicking the delete button
      if ((e.target as HTMLElement).closest('.conversation-item-delete')) return;
      const id = (item as HTMLElement).dataset.id;
      if (id) {
        host.showConversationPanel = false;
        host.conversationSearch = '';
        host.postMessage({ type: 'switchConversation', conversationId: id });
      }
    });
  });

  // Delete conversation buttons
  document.querySelectorAll('.conversation-item-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.deleteId;
      if (id) {
        host.postMessage({ type: 'deleteConversation', conversationId: id });
      }
    });
  });
}
