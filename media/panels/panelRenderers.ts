import { escapeHtml, renderMarkdown } from '../markdownRenderer';
import { escapeAttr } from '../webviewUtils';
import type { PendingConfirmation, PendingPlanApproval, PendingQuestion } from './panelTypes';

export function renderApprovalPanel(conf: PendingConfirmation): string {
  const toolLabel = escapeHtml(conf.toolName);
  return `
    <div class="composer approval-panel" role="dialog" aria-label="Tool approval">
      <div class="approval-question">Allow <strong>${toolLabel}</strong>?</div>
      <div class="approval-options">
        <button class="approval-option" data-approval="allow" aria-label="Allow this action">
          <span class="approval-key">1</span>
          <span class="approval-label">Yes</span>
        </button>
        <button class="approval-option" data-approval="alwaysAllow" aria-label="Allow all edits for this session">
          <span class="approval-key">2</span>
          <span class="approval-label">Yes, allow all edits this session</span>
        </button>
        <button class="approval-option" data-approval="reject" aria-label="Reject this action">
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
            aria-label="Approval feedback"
          />
        </div>
      </div>
      <div class="approval-hint">Esc to cancel</div>
    </div>
  `;
}

export function renderQuestionPanel(pq: PendingQuestion): string {
  const navHtml = pq.questions.map((q, idx) => `
    <button
      class="question-nav-item"
      type="button"
      data-nav-idx="${idx}"
      data-question-idx="${idx}"
      title="${escapeAttr(q.header)}"
    >
      ${escapeHtml(q.header)}
    </button>
  `).join('');

  const submitNavIndex = pq.questions.length;

  return `
    <div class="composer question-panel" data-request-id="${pq.requestId}" role="dialog" aria-label="Questionnaire">
      <div class="question-nav" role="tablist" aria-label="Question navigation">
        ${navHtml}
        <button
          class="question-nav-item question-submit-item"
          type="button"
          data-nav-idx="${submitNavIndex}"
        >
          Submit answers
        </button>
      </div>
      <div class="question-stage"></div>
      <div class="question-review"></div>
      <div class="question-submit-error"></div>
      <div class="approval-hint question-hint">Enter to select · Left/Right to switch question · Esc to cancel</div>
    </div>
  `;
}

export function renderPlanApprovalPanel(pp: PendingPlanApproval): string {
  const planContentHtml = pp.plan
    ? `<div class="plan-content">${renderMarkdown(pp.plan)}</div>`
    : '';

  return `
    <div class="composer plan-approval-panel" data-request-id="${pp.requestId}" role="dialog" aria-label="Plan approval">
      <div class="plan-approval-question">Approve this plan?</div>
      ${planContentHtml}
      <div class="approval-options">
        <button class="approval-option" data-plan-option="smart" aria-label="Approve plan and use smart mode edits">
          <span class="approval-key">1</span>
          <span class="approval-label">Yes, and use smart mode edits</span>
        </button>
        <button class="approval-option" data-plan-option="default" aria-label="Approve plan and require manual edit approvals">
          <span class="approval-key">2</span>
          <span class="approval-label">Yes, and manually approve edits</span>
        </button>
        <button class="approval-option" data-plan-option="keep" aria-label="Keep planning">
          <span class="approval-key">3</span>
          <span class="approval-label">No, keep planning</span>
        </button>
        <div class="approval-option plan-feedback-option">
          <span class="approval-key">4</span>
          <input
            type="text"
            class="approval-feedback-input plan-feedback-input"
            placeholder="Tell iFlow what to do instead..."
            aria-label="Plan feedback"
          />
        </div>
      </div>
      <div class="approval-hint">Esc to keep planning</div>
    </div>
  `;
}
