import type { AppHost } from "../eventBinder";
import { isPlanOption } from "./panelTypes";
import { beginPanelListenerLifecycle } from "./panelListenerLifecycle";

const planApprovalListeners = { current: null as AbortController | null };

export function attachPlanApprovalListeners(host: AppHost): void {
  const pp = host.appState.pendingPlanApproval;
  if (!pp) return;

  const panel = document.querySelector(".plan-approval-panel");
  if (!panel) {
    return;
  }

  const listenersAbortController = beginPanelListenerLifecycle(
    planApprovalListeners,
    () => !document.body.contains(panel),
  );

  const handleOption = (
    option: "smart" | "default" | "keep" | "feedback",
    feedback?: string,
  ) => {
    host.postMessage({
      type: "planApproval",
      requestId: pp.requestId,
      option,
      feedback,
    });
    host.appState.pendingPlanApproval = null;
    host.render();
  };

  document.querySelectorAll("[data-plan-option]").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => {
        const option = (btn as HTMLElement).dataset.planOption;
        if (isPlanOption(option)) {
          handleOption(option);
        }
      },
      { signal: listenersAbortController.signal },
    );
  });

  const feedbackInput = document.querySelector(
    ".plan-feedback-input",
  ) as HTMLInputElement | null;
  if (feedbackInput) {
    feedbackInput.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const text = feedbackInput.value.trim();
          if (text) {
            handleOption("feedback", text);
          }
        }
      },
      { signal: listenersAbortController.signal },
    );
  }

  const keyHandler = (e: KeyboardEvent) => {
    if (document.activeElement === feedbackInput) return;

    if (e.key === "1") {
      e.preventDefault();
      handleOption("smart");
    } else if (e.key === "2") {
      e.preventDefault();
      handleOption("default");
    } else if (e.key === "3") {
      e.preventDefault();
      handleOption("keep");
    } else if (e.key === "4") {
      e.preventDefault();
      feedbackInput?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleOption("keep");
    }
  };
  document.addEventListener("keydown", keyHandler, {
    signal: listenersAbortController.signal,
  });
}
