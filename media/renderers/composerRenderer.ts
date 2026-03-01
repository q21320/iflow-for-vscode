import type {
  Conversation,
  ConversationMode,
  IDEContext,
  RoundFileChangeSummary,
} from "../../src/protocol";
import { MODELS } from "../../src/protocol";
import { escapeHtml } from "../markdownRenderer";
import { escapeAttr } from "../webviewUtils";
import type {
  PendingConfirmation,
  PendingPlanApproval,
  PendingQuestion,
} from "../panels/panelTypes";
import {
  renderApprovalPanel,
  renderPlanApprovalPanel,
  renderQuestionPanel,
} from "../panels/panelRenderers";
import {
  getPieSlicePath,
  getModeLabel,
  renderFileIcon,
} from "./sharedRendererUtils";

function renderModePopup(
  mode: ConversationMode,
  isThinking: boolean,
  showModeMenu: boolean,
): string {
  return `
    <div class="mode-popup ${showModeMenu ? "" : "hidden"}" id="mode-popup" role="listbox" aria-label="Conversation mode options">
      <div class="mode-option ${mode === "default" ? "active" : ""}" data-mode="default" role="option" tabindex="0" aria-selected="${mode === "default" ? "true" : "false"}">
        <span class="mode-option-label">Chat</span>
        <span class="mode-option-desc">Normal conversation</span>
      </div>
      <div class="mode-option ${mode === "yolo" ? "active" : ""}" data-mode="yolo" role="option" tabindex="0" aria-selected="${mode === "yolo" ? "true" : "false"}">
        <span class="mode-option-label">YOLO</span>
        <span class="mode-option-desc">Auto-approve actions</span>
      </div>
      <div class="mode-option ${mode === "plan" ? "active" : ""}" data-mode="plan" role="option" tabindex="0" aria-selected="${mode === "plan" ? "true" : "false"}">
        <span class="mode-option-label">Plan</span>
        <span class="mode-option-desc">Plan before executing</span>
      </div>
      <div class="mode-option ${mode === "smart" ? "active" : ""}" data-mode="smart" role="option" tabindex="0" aria-selected="${mode === "smart" ? "true" : "false"}">
        <span class="mode-option-label">Smart</span>
        <span class="mode-option-desc">AI-driven edits</span>
      </div>
      <div class="mode-popup-divider"></div>
      <div
        class="mode-option think-option"
        id="think-option"
        role="button"
        tabindex="0"
        aria-label="Toggle thinking mode"
        aria-pressed="${isThinking ? "true" : "false"}"
      >
        <span class="mode-option-label">🧠 Thinking</span>
        <div class="toggle-switch ${isThinking ? "active" : ""}">
          <div class="toggle-knob"></div>
        </div>
      </div>
    </div>
  `;
}

export function renderIDEContextChips(
  context: IDEContext,
  dismissed: { activeFile: boolean; selection: boolean },
): string {
  const chips: string[] = [];

  if (context.activeFile && !dismissed.activeFile) {
    chips.push(`
      <div class="ide-context-chip" title="${escapeAttr(context.activeFile.path)}">
        ${renderFileIcon(context.activeFile.path)}
        <span class="ide-context-label">${escapeHtml(context.activeFile.name)}</span>
        <button class="ide-context-dismiss" data-dismiss="activeFile" title="Remove" aria-label="Dismiss active file context">&times;</button>
      </div>
    `);
  }

  if (context.selection && !dismissed.selection) {
    const label = `${context.selection.fileName}:${context.selection.lineStart}-${context.selection.lineEnd}`;
    chips.push(`
      <div class="ide-context-chip" title="${escapeAttr(context.selection.text.substring(0, 200))}">
        <span class="file-icon">&#9986;</span>
        <span class="ide-context-label">${escapeHtml(label)}</span>
        <button class="ide-context-dismiss" data-dismiss="selection" title="Remove" aria-label="Dismiss selection context">&times;</button>
      </div>
    `);
  }

  if (chips.length === 0) {
    return "";
  }

  return `<div class="ide-context-chips" id="ide-context-chips">${chips.join("")}</div>`;
}

export function renderComposer(opts: {
  conversation: Conversation | null;
  isStreaming: boolean;
  pendingConfirmation: PendingConfirmation | null;
  pendingQuestion: PendingQuestion | null;
  pendingPlanApproval: PendingPlanApproval | null;
  roundFileChanges?: RoundFileChangeSummary;
  ideContextChipsHtml: string;
  attachedFilesHtml: string;
  slashMenuHtml: string;
  mentionMenuHtml: string;
  contextUsage:
    | { percent: number; usedTokens: number; totalTokens: number }
    | undefined;
  showModeMenu: boolean;
  cwd?: string;
  workspaceFolderName?: string;
  isMultiRoot: boolean;
}): string {
  if (opts.pendingConfirmation) {
    return renderApprovalPanel(opts.pendingConfirmation);
  }

  if (opts.pendingQuestion) {
    return renderQuestionPanel(opts.pendingQuestion);
  }

  if (opts.pendingPlanApproval) {
    return renderPlanApprovalPanel(opts.pendingPlanApproval);
  }

  const conversation = opts.conversation;
  const isThinking = conversation?.think ?? false;
  const currentModel = conversation?.model ?? "GLM-4.7";

  return `
    <div class="composer">
      ${renderRoundFileChanges(opts.roundFileChanges)}
      ${opts.ideContextChipsHtml}
      ${opts.attachedFilesHtml}
      <div class="composer-input-row">
        <button id="attach-btn" class="icon-btn" title="Attach files" aria-label="Attach files">
          <span class="icon">📎</span>
        </button>
          <div class="input-wrapper">
          <textarea
            id="message-input"
            placeholder="Message iFlow..."
            rows="1"
            aria-label="Message input"
          ></textarea>
          ${opts.slashMenuHtml}
          ${opts.mentionMenuHtml}
        </div>
        ${
          opts.isStreaming
            ? `
          <button id="cancel-btn" class="icon-btn danger stop-btn" title="Stop" aria-label="Stop response generation">
            <span class="stop-glyph" aria-hidden="true"></span>
          </button>
        `
            : `
          <button id="send-btn" class="icon-btn primary" title="Send" aria-label="Send message">
            <span class="icon">➤</span>
          </button>
        `
        }
      </div>
      <div class="composer-status-bar">
        <div class="status-left">
           ${
             opts.cwd
               ? `
             <div class="status-item cwd-indicator" title="${escapeAttr(opts.cwd)}">
               <span class="cwd-icon" aria-hidden="true">📁</span>
               <span class="cwd-path">${escapeHtml(opts.cwd.split(/[\\/]/).pop() || opts.cwd)}</span>
             </div>
           `
               : ""
           }
           <div class="status-item mode-selector-wrapper">
              <button
                id="mode-trigger"
                class="mode-trigger"
                aria-label="Choose mode"
                aria-haspopup="listbox"
                aria-expanded="${opts.showModeMenu ? "true" : "false"}"
                aria-controls="mode-popup"
              >
                <span>${getModeLabel(conversation?.mode || "default")}</span>
                <span class="chevron">▾</span>
              </button>
              ${renderModePopup(conversation?.mode || "default", isThinking, opts.showModeMenu)}
           </div>
           ${isThinking ? '<span class="thinking-chip">🧠 Thinking</span>' : ""}
           <div class="status-item">
             <select id="model-select" class="dropdown-mini" title="Select Model" aria-label="Select model">
               ${MODELS.map(
                 (m) => `
                 <option value="${m}" ${currentModel === m ? "selected" : ""}>${m}</option>
               `,
               ).join("")}
             </select>
           </div>
        </div>
        ${renderContextUsage(opts.contextUsage)}
      </div>
    </div>
  `;
}

export function renderRoundFileChanges(
  summary: RoundFileChangeSummary | undefined,
): string {
  if (!summary || summary.changedFiles.length === 0) {
    return "";
  }

  const visibleFiles = summary.changedFiles.filter(
    (file) => file.status !== "accepted",
  );
  if (visibleFiles.length === 0) {
    return "";
  }

  const fileCount = visibleFiles.length;
  const fileLabel = fileCount === 1 ? "file" : "files";
  const totalAdded = visibleFiles.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = visibleFiles.reduce(
    (sum, file) => sum + file.removed,
    0,
  );
  const rowsHtml = visibleFiles
    .map(
      (file) => `
    <div
      class="round-file-change-row status-${file.status}"
      role="button"
      tabindex="0"
      data-file-change-row="1"
      data-file-change-path="${escapeAttr(file.path)}"
      data-file-change-conversation-id="${escapeAttr(summary.conversationId)}"
      data-file-change-assistant-id="${escapeAttr(summary.assistantMessageId)}"
      title="${escapeAttr(file.path)}"
      aria-label="Open diff for ${escapeAttr(file.displayPath)}"
    >
      <span class="round-file-change-main">
        ${renderFileIcon(file.path, "round-file-change-icon")}
        <span class="round-file-change-path">${escapeHtml(file.displayPath)}</span>
        <span class="round-file-change-kind">${escapeHtml(file.kind)}</span>
      </span>
      <span class="round-file-change-stats">
        <span class="round-file-change-added">+${file.added}</span>
        <span class="round-file-change-removed">-${file.removed}</span>
      </span>
      <span class="round-file-change-actions">
        <button
          type="button"
          class="round-file-change-action approve"
          data-file-change-action="approve"
          data-file-change-path="${escapeAttr(file.path)}"
          data-file-change-conversation-id="${escapeAttr(summary.conversationId)}"
          data-file-change-assistant-id="${escapeAttr(summary.assistantMessageId)}"
          aria-label="Approve ${escapeAttr(file.displayPath)}"
          title="同意"
        >
          ✓
        </button>
        <button
          type="button"
          class="round-file-change-action rollback"
          data-file-change-action="rollback"
          data-file-change-path="${escapeAttr(file.path)}"
          data-file-change-conversation-id="${escapeAttr(summary.conversationId)}"
          data-file-change-assistant-id="${escapeAttr(summary.assistantMessageId)}"
          aria-label="Rollback ${escapeAttr(file.displayPath)}"
          title="撤销"
        >
          撤销
        </button>
      </span>
    </div>
  `,
    )
    .join("");

  return `
    <div class="round-file-changes-card" aria-label="Round file changes summary">
      <div class="round-file-changes-header">
        <span>${fileCount} ${fileLabel} changed</span>
        <span class="round-file-changes-total">
          <span class="round-file-change-added">+${totalAdded}</span>
          <span class="round-file-change-removed">-${totalRemoved}</span>
        </span>
      </div>
      <div class="round-file-changes-list">
        ${rowsHtml}
      </div>
    </div>
  `;
}

function renderContextUsage(
  usage:
    | { percent: number; usedTokens: number; totalTokens: number }
    | undefined,
): string {
  if (!usage || usage.usedTokens === 0) return "";
  const percent = usage.percent;
  const colorClass =
    percent >= 80
      ? "context-high"
      : percent >= 50
        ? "context-mid"
        : "context-low";
  const label = percent === 0 ? "<1%" : `${percent}%`;
  const piePath = getPieSlicePath(18, 18, 16, percent, usage.usedTokens);
  return `
    <div class="status-right">
      <div class="context-usage ${colorClass}" title="${usage.usedTokens.toLocaleString()} / ${usage.totalTokens.toLocaleString()} tokens">
        <svg class="context-pie" width="16" height="16" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="16" fill="var(--vscode-widget-border, rgba(128,128,128,0.3))"/>
          ${piePath ? `<path d="${piePath}" fill="currentColor"/>` : ""}
        </svg>
        <span>${label}</span>
      </div>
    </div>
  `;
}
