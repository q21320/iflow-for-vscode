import { escapeHtml, renderMarkdown } from '../markdownRenderer';
import { escapeAttr } from '../webviewUtils';
import type { PendingConfirmation, PendingPlanApproval, PendingQuestion } from './panelTypes';

export function renderApprovalPanel(conf: PendingConfirmation): string {
  const toolLabel = escapeHtml(conf.toolName);
  return `
    <div class="composer approval-panel">
      <div class="approval-question">Allow <strong>${toolLabel}</strong>?</div>
      <div class="approval-options">
        <button class="approval-option" data-approval="allow">
          <span class="approval-key">1</span>
          <span class="approval-label">Yes</span>
        </button>
        <button class="approval-option" data-approval="alwaysAllow">
          <span class="approval-key">2</span>
          <span class="approval-label">Yes, allow all edits this session</span>
        </button>
        <button class="approval-option" data-approval="reject">
          <span class="approval-key">3</span>
          <span class="approval-label">No</span>
        </button>
        <div class="approval-option feedback-option">
          <span class="approval-key">4</span>
          <input
            type="text"
            id="approval-feedback-input"
            class="approval-feedback-input"
            placeholder="Tell IFlow what to do instead..."
          />
        </div>
      </div>
      <div class="approval-hint">Esc to cancel</div>
    </div>
  `;
}

export function renderQuestionPanel(pq: PendingQuestion): string {
  const questionsHtml = pq.questions.map((q, qIdx) => {
    let keyIndex = 1;
    const optionsHtml = q.options.map((opt) => {
      const key = keyIndex++;
      return `
        <button class="approval-option question-option" data-question-idx="${qIdx}" data-option-label="${escapeAttr(opt.label)}">
          <span class="approval-key">${key}</span>
          <span class="approval-label">${escapeHtml(opt.label)}</span>
          ${opt.description ? `<span class="option-description">${escapeHtml(opt.description)}</span>` : ''}
        </button>
      `;
    }).join('');

    const otherKey = keyIndex;
    const otherHtml = `
      <div class="approval-option feedback-option">
        <span class="approval-key">${otherKey}</span>
        <input
          type="text"
          class="approval-feedback-input question-other-input"
          data-question-idx="${qIdx}"
          placeholder="Other..."
        />
      </div>
    `;

    return `
      <div class="question-item" data-question-idx="${qIdx}" data-question-header="${escapeAttr(q.header)}">
        <div class="question-text">${escapeHtml(q.question)}</div>
        <div class="approval-options">
          ${optionsHtml}
          ${otherHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="composer question-panel" data-request-id="${pq.requestId}">
      ${questionsHtml}
      <div class="approval-hint">Esc to cancel</div>
    </div>
  `;
}

export function renderPlanApprovalPanel(pp: PendingPlanApproval): string {
  const planContentHtml = pp.plan
    ? `<div class="plan-content">${renderMarkdown(pp.plan)}</div>`
    : '';

  return `
    <div class="composer plan-approval-panel" data-request-id="${pp.requestId}">
      <div class="plan-approval-question">Approve this plan?</div>
      ${planContentHtml}
      <div class="approval-options">
        <button class="approval-option" data-plan-option="smart">
          <span class="approval-key">1</span>
          <span class="approval-label">Yes, and use smart mode edits</span>
        </button>
        <button class="approval-option" data-plan-option="default">
          <span class="approval-key">2</span>
          <span class="approval-label">Yes, and manually approve edits</span>
        </button>
        <button class="approval-option" data-plan-option="keep">
          <span class="approval-key">3</span>
          <span class="approval-label">No, keep planning</span>
        </button>
        <div class="approval-option plan-feedback-option">
          <span class="approval-key">4</span>
          <input
            type="text"
            class="approval-feedback-input plan-feedback-input"
            placeholder="Tell iFlow what to do instead..."
          />
        </div>
      </div>
      <div class="approval-hint">Esc to keep planning</div>
    </div>
  `;
}
