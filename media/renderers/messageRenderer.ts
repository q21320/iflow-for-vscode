import type { Conversation, Message, OutputBlock } from '../../src/protocol';
import { escapeAttr } from '../webviewUtils';
import { escapeHtml, renderMarkdown } from '../markdownRenderer';
import { getFileName } from '../fileUtils';
import { getToolHeadline, renderToolDetailPreview } from '../toolRenderers';
import { formatTime, renderFileIcon } from './sharedRendererUtils';

export function renderMessages(
  conversation: Conversation | null,
  isStreaming: boolean,
  faviconUri: string,
  pendingStatusText = 'Flowing...',
): string {
  if (!conversation || conversation.messages.length === 0) {
    return `
      <div class="messages" id="messages-container">
        <div class="empty-state">
          <div class="logo"><img src="${faviconUri}" alt="IFlow" class="logo-icon" /></div>
          <h2>Welcome to IFlow</h2>
          <p>Start a conversation by typing a message below.</p>
          <p class="hint">Use / for commands, @ to mention files</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="messages" id="messages-container">
      ${conversation.messages.map((m) => renderMessage(m)).join('')}
      ${isStreaming ? renderPendingIndicator(faviconUri, pendingStatusText) : ''}
    </div>
  `;
}

function renderMessage(message: Message): string {
  const isUser = message.role === 'user';

  return `
    <div class="message ${isUser ? 'user' : 'assistant'}">
      <div class="message-header">
        <span class="role">${isUser ? 'You' : 'IFlow'}</span>
        <span class="timestamp">${formatTime(message.timestamp)}</span>
      </div>
      ${message.attachedFiles.length > 0 ? `
        <div class="attached-files-display">
          ${message.attachedFiles.map((f) => `
            <button
              class="file-chip small file-open-btn"
              data-open-file-path="${escapeAttr(f.path)}"
              title="Open ${escapeAttr(getFileName(f.path))}"
              aria-label="Open file ${escapeAttr(getFileName(f.path))}"
            >
              ${renderFileIcon(f.path)}
              <span class="file-name">${escapeHtml(getFileName(f.path))}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
      <div class="message-content">
        ${message.blocks.map((b) => renderBlock(b)).join('')}
      </div>
    </div>
  `;
}

export function renderBlock(block: OutputBlock): string {
  switch (block.type) {
    case 'text':
      return `<div class="block-text">${renderMarkdown(block.content)}</div>`;

    case 'code':
      return `
        <div class="block-code">
          <div class="code-header">
            <span class="language">${escapeHtml(block.language)}${block.filename ? ` - ${escapeHtml(block.filename)}` : ''}</span>
            <button class="copy-btn" data-content="${escapeAttr(block.content)}">Copy</button>
          </div>
          <pre><code>${escapeHtml(block.content)}</code></pre>
        </div>
      `;

    case 'tool': {
      const detailPreview = renderToolDetailPreview(block);
      return `
        <div class="tool-entry">
          <div class="block-tool ${block.status}">
            <span class="tool-icon ${block.status}">${block.status === 'running' ? '⏳' : block.status === 'completed' ? '✓' : '✗'}</span>
            <span class="tool-headline">${escapeHtml(getToolHeadline(block))}</span>
          </div>
          ${detailPreview}
        </div>
      `;
    }

    case 'thinking':
      return `
        <div class="block-thinking ${block.collapsed ? 'collapsed' : ''}">
          <div class="thinking-header" data-collapsible>
            <span class="thinking-icon">💭</span>
            <span>Thinking...</span>
            <span class="expand-icon">▼</span>
          </div>
          <div class="thinking-content ${block.collapsed ? 'collapsed' : ''}">
            ${escapeHtml(block.content)}
          </div>
        </div>
      `;

    case 'file_ref':
      return `
        <div class="block-file-ref">
          ${renderFileIcon(block.path)}
          <span class="file-path">${escapeHtml(block.path)}</span>
          ${block.lineStart ? `<span class="line-range">:${block.lineStart}${block.lineEnd ? `-${block.lineEnd}` : ''}</span>` : ''}
        </div>
      `;

    case 'error':
      return `
        <div class="block-error">
          <span class="icon">❌</span>
          <span>${escapeHtml(block.message)}</span>
        </div>
      `;

    case 'plan':
      return renderPlanBlock(block.entries);

    case 'warning':
      return `
        <div class="block-warning">
          <span class="icon">⚠</span>
          <span>${escapeHtml(block.message)}</span>
        </div>
      `;
  }
}

function renderPlanBlock(entries: Array<{ content: string; status: string; priority: string }>): string {
  const pending = entries.filter((e) => e.status === 'pending').length;
  const inProgress = entries.filter((e) => e.status === 'in_progress').length;
  const completed = entries.filter((e) => e.status === 'completed').length;
  const allDone = completed === entries.length && entries.length > 0;

  const summaryParts: string[] = [];
  if (pending > 0) summaryParts.push(`${pending} pending`);
  if (inProgress > 0) summaryParts.push(`${inProgress} in progress`);
  if (completed > 0) summaryParts.push(`${completed} completed`);
  const summary = summaryParts.length > 0 ? summaryParts.join(', ') : 'empty';

  const statusIcon = allDone ? '✓' : '⏳';
  const statusClass = allDone ? 'completed' : 'running';

  const entriesHtml = entries.map((entry) => {
    let icon: string;
    let entryStatusClass: string;
    switch (entry.status) {
      case 'completed':
        icon = '✓';
        entryStatusClass = 'completed';
        break;
      case 'in_progress':
        icon = '⏳';
        entryStatusClass = 'in-progress';
        break;
      default:
        icon = '☐';
        entryStatusClass = 'pending';
    }
    return `
      <div class="plan-entry ${entryStatusClass}">
        <span class="plan-entry-icon ${entryStatusClass}">${icon}</span>
        <span class="plan-entry-text">${escapeHtml(entry.content)}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="tool-entry">
      <div class="block-tool ${statusClass}">
        <span class="tool-icon ${statusClass}">${statusIcon}</span>
        <span class="tool-headline">Plan · ${escapeHtml(summary)}</span>
      </div>
      <div class="plan-entries">
        ${entriesHtml}
      </div>
    </div>
  `;
}

export function renderPendingIndicator(faviconUri: string, statusText = 'Flowing...'): string {
  return `
    <div class="pending-indicator">
      <div class="bounce-logo"><img src="${faviconUri}" alt="IFlow" class="bounce-logo-icon" /></div>
      <span>${escapeHtml(statusText)}</span>
    </div>
  `;
}
