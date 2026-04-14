import { escapeHtml, renderMarkdown } from '../markdownRenderer';
import { escapeAttr } from '../webviewUtils';
import type { PendingConfirmation, PendingPlanApproval, PendingQuestion } from './panelTypes';

export function renderApprovalPanel(conf: PendingConfirmation): string {
  const toolLabel = escapeHtml(conf.toolName);
  return `
    <div class="composer approval-panel" role="dialog" aria-label="Tool approval">
      <div class="approval-question">允许 <strong>${toolLabel}</strong>?</div>
      <div class="approval-options">
        <button class="approval-option" data-approval="allow" aria-label="Allow this action">
          <span class="approval-key">1</span>
          <span class="approval-label">允许</span>
        </button>
        <button class="approval-option" data-approval="alwaysAllow" aria-label="Allow all edits for this session">
          <span class="approval-key">2</span>
          <span class="approval-label">允许本次会话中的所有编辑操作</span>
        </button>
        <button class="approval-option" data-approval="reject" aria-label="Reject this action">
          <span class="approval-key">3</span>
          <span class="approval-label">拒绝</span>
        </button>
        <div class="approval-option feedback-option">
          <span class="approval-key">4</span>
          <input
            type="text"
            id="approval-feedback-input"
            class="approval-feedback-input"
            placeholder="改为告知 Niren 该如何操作..."
            aria-label="Approval feedback"
          />
        </div>
      </div>
      <div class="approval-hint">按 Esc 键取消</div>
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
          提交答案
        </button>
      </div>
      <div class="question-stage"></div>
      <div class="question-review"></div>
      <div class="question-submit-error"></div>
      <div class="approval-hint question-hint">按回车键选择・左右方向键切换题目・按 Esc 键取消</div>
    </div>
  `;
}

export function renderPlanApprovalPanel(pp: PendingPlanApproval): string {
  const planContentHtml = pp.plan
    ? `<div class="plan-content">${renderMarkdown(pp.plan)}</div>`
    : '';

  return `
    <div class="composer plan-approval-panel" data-request-id="${pp.requestId}" role="dialog" aria-label="Plan approval">
      <div class="plan-approval-question">允许此计划?</div>
      ${planContentHtml}
      <div class="approval-options">
        <button class="approval-option" data-plan-option="smart" aria-label="Approve plan and use smart mode edits">
          <span class="approval-key">1</span>
          <span class="approval-label">是的，并使用智能模式编辑</span>
        </button>
        <button class="approval-option" data-plan-option="default" aria-label="Approve plan and require manual edit approvals">
          <span class="approval-key">2</span>
          <span class="approval-label">是的，手动审批编辑</span>
        </button>
        <button class="approval-option" data-plan-option="keep" aria-label="Keep planning">
          <span class="approval-key">3</span>
          <span class="approval-label">继续规划</span>
        </button>
        <div class="approval-option plan-feedback-option">
          <span class="approval-key">4</span>
          <input
            type="text"
            class="approval-feedback-input plan-feedback-input"
            placeholder="改为告知 Niren 该如何操作..."
            aria-label="Plan feedback"
          />
        </div>
      </div>
      <div class="approval-hint">按 Esc 键继续规划</div>
    </div>
  `;
}
