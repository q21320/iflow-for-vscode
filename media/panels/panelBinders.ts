import type { AppHost } from '../eventBinder';

export function attachApprovalListeners(host: AppHost): void {
  const conf = host.getPendingConfirmation();
  if (!conf) return;

  const handleApproval = (outcome: 'allow' | 'alwaysAllow' | 'reject') => {
    host.postMessage({ type: 'toolApproval', requestId: conf.requestId, outcome });
    if (outcome === 'alwaysAllow') {
      host.postMessage({ type: 'setMode', mode: 'smart' });
    }
    host.clearPendingConfirmation();
    host.render();
  };

  document.querySelectorAll('.approval-option[data-approval]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const outcome = (btn as HTMLElement).dataset.approval as 'allow' | 'alwaysAllow' | 'reject';
      handleApproval(outcome);
    });
  });

  const feedbackInput = document.getElementById('approval-feedback-input') as HTMLInputElement | null;
  feedbackInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      host.postMessage({ type: 'toolApproval', requestId: conf.requestId, outcome: 'reject' });
      host.clearPendingConfirmation();
      host.render();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleApproval('reject');
    }
  });

  const keyHandler = (e: KeyboardEvent) => {
    if (document.activeElement === feedbackInput) return;

    if (e.key === '1') { e.preventDefault(); handleApproval('allow'); }
    else if (e.key === '2') { e.preventDefault(); handleApproval('alwaysAllow'); }
    else if (e.key === '3') { e.preventDefault(); handleApproval('reject'); }
    else if (e.key === 'Escape') { e.preventDefault(); handleApproval('reject'); }
    else if (e.key === '4') {
      e.preventDefault();
      feedbackInput?.focus();
    }
  };
  document.addEventListener('keydown', keyHandler);

  const observer = new MutationObserver(() => {
    if (!document.querySelector('.approval-panel')) {
      document.removeEventListener('keydown', keyHandler);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function attachQuestionListeners(host: AppHost): void {
  const pq = host.getPendingQuestion();
  if (!pq) return;

  const handleSubmitAnswers = (answers: Record<string, string | string[]>) => {
    host.postMessage({ type: 'questionAnswer', requestId: pq.requestId, answers });
    host.clearPendingQuestion();
    host.render();
  };

  const handleCancel = () => {
    const answers: Record<string, string> = {};
    for (const q of pq.questions) {
      answers[q.header] = '';
    }
    handleSubmitAnswers(answers);
  };

  const isSingleQuestionSingleSelect = pq.questions.length === 1 && !pq.questions[0].multiSelect;

  document.querySelectorAll('.question-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const qIdx = parseInt(el.dataset.questionIdx || '0', 10);
      const optionLabel = el.dataset.optionLabel || '';

      if (isSingleQuestionSingleSelect) {
        const answers: Record<string, string> = {};
        answers[pq.questions[qIdx].header] = optionLabel;
        handleSubmitAnswers(answers);
      } else {
        el.classList.toggle('selected');
      }
    });
  });

  document.querySelectorAll('.question-other-input').forEach((input) => {
    (input as HTMLInputElement).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const el = input as HTMLInputElement;
        const qIdx = parseInt(el.dataset.questionIdx || '0', 10);
        const value = el.value.trim();
        if (!value) return;

        if (isSingleQuestionSingleSelect) {
          const answers: Record<string, string> = {};
          answers[pq.questions[qIdx].header] = value;
          handleSubmitAnswers(answers);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    });
  });

  const otherInput = document.querySelector('.question-other-input') as HTMLInputElement | null;
  const keyHandler = (e: KeyboardEvent) => {
    if (document.activeElement && (document.activeElement as HTMLElement).classList?.contains('question-other-input')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
      return;
    }

    if (isSingleQuestionSingleSelect) {
      const q = pq.questions[0];
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= q.options.length) {
        e.preventDefault();
        const answers: Record<string, string> = {};
        answers[q.header] = q.options[num - 1].label;
        handleSubmitAnswers(answers);
      } else if (num === q.options.length + 1) {
        e.preventDefault();
        otherInput?.focus();
      }
    }
  };
  document.addEventListener('keydown', keyHandler);

  const observer = new MutationObserver(() => {
    if (!document.querySelector('.question-panel')) {
      document.removeEventListener('keydown', keyHandler);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function attachPlanApprovalListeners(host: AppHost): void {
  const pp = host.getPendingPlanApproval();
  if (!pp) return;

  const handleOption = (option: 'smart' | 'default' | 'keep' | 'feedback', feedback?: string) => {
    host.postMessage({ type: 'planApproval', requestId: pp.requestId, option, feedback });
    host.clearPendingPlanApproval();
    host.render();
  };

  document.querySelectorAll('[data-plan-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const option = (btn as HTMLElement).dataset.planOption as 'smart' | 'default' | 'keep';
      if (option) {
        handleOption(option);
      }
    });
  });

  const feedbackInput = document.querySelector('.plan-feedback-input') as HTMLInputElement | null;
  if (feedbackInput) {
    feedbackInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = feedbackInput.value.trim();
        if (text) {
          handleOption('feedback', text);
        }
      }
    });
  }

  const keyHandler = (e: KeyboardEvent) => {
    if (document.activeElement === feedbackInput) return;

    if (e.key === '1') { e.preventDefault(); handleOption('smart'); }
    else if (e.key === '2') { e.preventDefault(); handleOption('default'); }
    else if (e.key === '3') { e.preventDefault(); handleOption('keep'); }
    else if (e.key === '4') { e.preventDefault(); feedbackInput?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); handleOption('keep'); }
  };
  document.addEventListener('keydown', keyHandler);

  const observer = new MutationObserver(() => {
    if (!document.querySelector('.plan-approval-panel')) {
      document.removeEventListener('keydown', keyHandler);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
