import type { AppHost } from '../eventBinder';
import { beginPanelListenerLifecycle } from './panelListenerLifecycle';

const approvalListeners = { current: null as AbortController | null };

function isApprovalOutcome(value: string | undefined): value is 'allow' | 'alwaysAllow' | 'reject' {
  return value === 'allow' || value === 'alwaysAllow' || value === 'reject';
}

export function attachApprovalListeners(host: AppHost): void {
  const conf = host.getPendingConfirmation();
  if (!conf) return;

  const panel = document.querySelector('.approval-panel');
  if (!panel) {
    return;
  }

  const listenersAbortController = beginPanelListenerLifecycle(
    approvalListeners,
    () => !document.body.contains(panel),
  );

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
      const outcome = (btn as HTMLElement).dataset.approval;
      if (!isApprovalOutcome(outcome)) {
        return;
      }
      handleApproval(outcome);
    }, { signal: listenersAbortController.signal });
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
  }, { signal: listenersAbortController.signal });

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
  document.addEventListener('keydown', keyHandler, { signal: listenersAbortController.signal });
}
