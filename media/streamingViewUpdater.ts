import type { Conversation, IDEContext } from "../src/protocol";
import {
  renderBlock,
  renderPendingIndicator,
} from "./renderers/messageRenderer";
import { renderIDEContextChips } from "./renderers/composerRenderer";
import { getModeLabel } from "./renderers/sharedRendererUtils";
import type { IDEContextDismissed } from "./appState";

export function updateStreamingContentView(options: {
  conversation: Conversation | null;
  fallbackRender: () => void;
  updatePendingIndicator: (container?: Element) => void;
  updateComposerStatusBar: () => void;
  scrollToBottom: () => void;
}): void {
  const { conversation } = options;
  if (!conversation) {
    options.fallbackRender();
    return;
  }

  const container = document.getElementById("messages-container");
  if (!container) {
    options.fallbackRender();
    return;
  }

  const lastMessage = conversation.messages[conversation.messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") {
    options.fallbackRender();
    return;
  }

  const messageElements = container.querySelectorAll(".message");
  const lastMessageEl = messageElements[messageElements.length - 1];
  if (!lastMessageEl || !lastMessageEl.classList.contains("assistant")) {
    options.fallbackRender();
    return;
  }

  const contentEl = lastMessageEl.querySelector(".message-content");
  if (contentEl) {
    contentEl.innerHTML = lastMessage.blocks
      .map((block) => renderBlock(block))
      .join("");
  }

  options.updatePendingIndicator(container);
  options.updateComposerStatusBar();
  options.scrollToBottom();
}

export function updateIDEContextChipsView(options: {
  ideContext: IDEContext;
  ideContextDismissed: IDEContextDismissed;
  onAfterPatch: () => void;
}): void {
  const existing = document.getElementById("ide-context-chips");
  const newHtml = renderIDEContextChips(
    options.ideContext,
    options.ideContextDismissed,
  );
  if (existing) {
    existing.outerHTML = newHtml;
  } else if (newHtml) {
    const composer = document.querySelector(".composer");
    if (composer) {
      composer.insertAdjacentHTML("afterbegin", newHtml);
    }
  }

  options.onAfterPatch();
}

let prevMode = "";
let prevModel = "";
let prevThink: boolean | null = null;

export function updateComposerStatusBarView(options: {
  conversation: Conversation | null;
  showModeMenu: boolean;
  autoSizeSelect: (select: HTMLSelectElement) => void;
}): void {
  const mode = options.conversation?.mode || "default";
  const isThinking = options.conversation?.think ?? false;
  const currentModel = options.conversation?.model ?? "GLM-4.7";

  const modeChanged = mode !== prevMode;
  const thinkChanged = isThinking !== prevThink;
  const modelChanged = currentModel !== prevModel;

  if (!modeChanged && !thinkChanged && !modelChanged) {
    return;
  }

  prevMode = mode;
  prevThink = isThinking;
  prevModel = currentModel;

  const modeTrigger = document.getElementById("mode-trigger");
  if (modeTrigger) {
    const labelSpan = modeTrigger.querySelector("span:first-child");
    if (labelSpan) {
      labelSpan.textContent = getModeLabel(mode);
    }
    modeTrigger.setAttribute(
      "aria-expanded",
      options.showModeMenu ? "true" : "false",
    );
  }

  document.querySelectorAll(".mode-option[data-mode]").forEach((el) => {
    const optionMode = (el as HTMLElement).dataset.mode;
    el.classList.toggle("active", optionMode === mode);
    el.setAttribute("aria-selected", optionMode === mode ? "true" : "false");
  });

  const toggleSwitch = document.querySelector("#think-option .toggle-switch");
  if (toggleSwitch) {
    toggleSwitch.classList.toggle("active", isThinking);
  }
  const thinkOption = document.getElementById("think-option");
  if (thinkOption) {
    thinkOption.setAttribute("aria-pressed", isThinking ? "true" : "false");
  }

  const statusLeft = document.querySelector(".status-left");
  const existingChip = document.querySelector(".thinking-chip");
  if (isThinking && !existingChip && statusLeft) {
    const modelItem = document
      .getElementById("model-select")
      ?.closest(".status-item");
    if (modelItem) {
      modelItem.insertAdjacentHTML(
        "beforebegin",
        '<span class="thinking-chip">🧠 Thinking</span>',
      );
    }
  } else if (!isThinking && existingChip) {
    existingChip.remove();
  }

  const modelSelect = document.getElementById(
    "model-select",
  ) as HTMLSelectElement | null;
  if (modelSelect && modelSelect.value !== currentModel) {
    modelSelect.value = currentModel;
    options.autoSizeSelect(modelSelect);
  }
}

export function updatePendingIndicatorView(options: {
  container?: Element;
  isStreaming: boolean;
  faviconUri: string;
  pendingStatusText: string;
}): void {
  const target =
    options.container ?? document.getElementById("messages-container");
  if (!target) {
    return;
  }

  const existingIndicator = target.querySelector(".pending-indicator");
  if (options.isStreaming) {
    const indicatorHtml = renderPendingIndicator(
      options.faviconUri,
      options.pendingStatusText,
    );
    if (existingIndicator) {
      (existingIndicator as HTMLElement).outerHTML = indicatorHtml;
    } else {
      target.insertAdjacentHTML("beforeend", indicatorHtml);
    }
    return;
  }

  existingIndicator?.remove();
}
