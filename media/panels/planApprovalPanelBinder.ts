import type { AppHost } from '../eventBinder';

let planApprovalListenersAbortController: AbortController | null = null;

function isPlanOption(value: string | undefined): value is 'smart' | 'default' | 'keep' {
  return value === 'smart' || value === 'default' || value === 'keep';
}

export function attachPlanApprovalListeners(host: AppHost): void {
  const pp = host.getPendingPlanApproval();
  if (!pp) return;

  planApprovalListenersAbortController?.abort();
  const listenersAbortController = new AbortController();
  planApprovalListenersAbortController = listenersAbortController;

  const handleOption = (option: 'smart' | 'default' | 'keep' | 'feedback', feedback?: string) => {
    host.postMessage({ type: 'planApproval', requestId: pp.requestId, option, feedback });
    host.clearPendingPlanApproval();
    host.render();
  };

  document.querySelectorAll('[data-plan-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const option = (btn as HTMLElement).dataset.planOption;
      if (isPlanOption(option)) {
        handleOption(option);
      }
    }, { signal: listenersAbortController.signal });
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
    }, { signal: listenersAbortController.signal });
  }

  const keyHandler = (e: KeyboardEvent) => {
    if (document.activeElement === feedbackInput) return;

    if (e.key === '1') { e.preventDefault(); handleOption('smart'); }
    else if (e.key === '2') { e.preventDefault(); handleOption('default'); }
    else if (e.key === '3') { e.preventDefault(); handleOption('keep'); }
    else if (e.key === '4') { e.preventDefault(); feedbackInput?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); handleOption('keep'); }
  };
  document.addEventListener('keydown', keyHandler, { signal: listenersAbortController.signal });

  const observer = new MutationObserver(() => {
    if (!document.querySelector('.plan-approval-panel')) {
      listenersAbortController.abort();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  listenersAbortController.signal.addEventListener('abort', () => {
    observer.disconnect();
    if (planApprovalListenersAbortController === listenersAbortController) {
      planApprovalListenersAbortController = null;
    }
  }, { once: true });
}
