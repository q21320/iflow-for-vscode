import type { AppHost } from "../eventBinder";
import {
  buildCancelledQuestionAnswerPayload,
  buildQuestionAnswerPayload,
  createQuestionPanelState,
  deriveQuestionPanelState,
  reduceQuestionPanelState,
  shouldSubmitAnswers,
} from "../../src/shared/questionPanelState";
import { QuestionPanelAction } from "../../src/shared/questionPanelTypes";
import {
  focusQuestionNavItem,
  renderQuestionPanelNav,
  renderQuestionReviewStage,
  renderQuestionStage,
} from "./questionPanelView";
import { beginPanelListenerLifecycle } from "./panelListenerLifecycle";

const questionListeners = { current: null as AbortController | null };

export function attachQuestionListeners(host: AppHost): void {
  const pq = host.appState.pendingQuestion;
  if (!pq) {
    return;
  }

  const panel = document.querySelector(".question-panel") as HTMLElement | null;
  if (!panel) {
    return;
  }

  const navEl = panel.querySelector(".question-nav") as HTMLElement | null;
  const stageEl = panel.querySelector(".question-stage") as HTMLElement | null;
  const reviewEl = panel.querySelector(
    ".question-review",
  ) as HTMLElement | null;
  const submitErrorEl = panel.querySelector(
    ".question-submit-error",
  ) as HTMLElement | null;
  if (!navEl || !stageEl || !reviewEl || !submitErrorEl) {
    return;
  }

  const listenersAbortController = beginPanelListenerLifecycle(
    questionListeners,
    () => !document.body.contains(panel),
  );

  let state = createQuestionPanelState(pq.questions);

  const handleSubmitAnswers = (answers: Record<string, string | string[]>) => {
    host.postMessage({
      type: "questionAnswer",
      requestId: pq.requestId,
      answers,
    });
    host.appState.pendingQuestion = null;
    host.render();
  };

  const handleCancel = () => {
    handleSubmitAnswers(buildCancelledQuestionAnswerPayload(state.questions));
  };

  const renderPanelState = (focusNav = false): void => {
    renderQuestionPanelNav(navEl, submitErrorEl, state);
    if (state.isReviewMode) {
      stageEl.classList.remove("is-visible");
      reviewEl.classList.add("is-visible");
      renderQuestionReviewStage(reviewEl, state);
    } else {
      reviewEl.classList.remove("is-visible");
      stageEl.classList.add("is-visible");
      renderQuestionStage(stageEl, state);
    }
    if (focusNav) {
      focusQuestionNavItem(navEl, state.activeNavIndex);
    }
  };

  const dispatch = (
    action: QuestionPanelAction,
    options: { focusNav?: boolean; focusOtherInput?: boolean } = {},
  ): void => {
    const previousState = state;
    state = reduceQuestionPanelState(state, action);
    if (
      action.type === "attemptSubmit" &&
      shouldSubmitAnswers(previousState, state)
    ) {
      handleSubmitAnswers(buildQuestionAnswerPayload(state));
      return;
    }

    renderPanelState(Boolean(options.focusNav));
    if (!options.focusOtherInput) {
      return;
    }

    const input = stageEl.querySelector(
      ".question-other-input",
    ) as HTMLInputElement | null;
    if (input) {
      input.focus();
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  };

  const activateOption = (optionIdx: number): void => {
    const derived = deriveQuestionPanelState(state);
    const question = derived.activeQuestion;
    const shouldFocusOtherInput = Boolean(
      question && optionIdx === question.options.length,
    );
    const shouldFocusSubmitNav = Boolean(
      question &&
      !question.multiSelect &&
      optionIdx < question.options.length &&
      state.activeQuestionIndex === state.questions.length - 1,
    );
    dispatch(
      { type: "activateOption", optionIdx },
      {
        focusNav: shouldFocusSubmitNav,
        focusOtherInput: shouldFocusOtherInput,
      },
    );
  };

  const moveNav = (delta: number): void => {
    dispatch({ type: "moveNav", delta }, { focusNav: true });
  };

  const moveActiveOption = (delta: number): void => {
    dispatch({ type: "moveOption", delta });
  };

  panel.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) {
        return;
      }

      const navButton = target.closest(
        ".question-nav-item",
      ) as HTMLButtonElement | null;
      if (navButton && navEl.contains(navButton)) {
        const navIdx = Number.parseInt(navButton.dataset.navIdx || "", 10);
        if (Number.isNaN(navIdx)) {
          return;
        }

        if (navIdx < state.questions.length) {
          dispatch({ type: "setNavIndex", navIndex: navIdx });
        } else {
          dispatch({ type: "setNavIndex", navIndex: navIdx });
          dispatch({ type: "attemptSubmit" }, { focusNav: true });
        }
        return;
      }

      const optionRow = target.closest(
        ".question-option[data-option-idx]",
      ) as HTMLElement | null;
      if (optionRow && stageEl.contains(optionRow)) {
        const optionIdx = Number.parseInt(
          optionRow.dataset.optionIdx || "",
          10,
        );
        if (!Number.isNaN(optionIdx)) {
          activateOption(optionIdx);
        }
      }
    },
    { signal: listenersAbortController.signal },
  );

  panel.addEventListener(
    "input",
    (e) => {
      const input = e.target as HTMLInputElement | null;
      if (!input || !input.classList.contains("question-other-input")) {
        return;
      }

      const questionIdx = Number.parseInt(input.dataset.questionIdx || "", 10);
      if (Number.isNaN(questionIdx) || !state.questions[questionIdx]) {
        return;
      }

      state = reduceQuestionPanelState(state, {
        type: "setOtherText",
        questionIdx,
        value: input.value,
      });
      renderQuestionPanelNav(navEl, submitErrorEl, state);
      const otherRow = input.closest(".question-other-row");
      otherRow?.classList.toggle("selected", input.value.trim().length > 0);
    },
    { signal: listenersAbortController.signal },
  );

  panel.addEventListener(
    "keydown",
    (e) => {
      const input = e.target as HTMLInputElement | null;
      if (!input || !input.classList.contains("question-other-input")) {
        return;
      }

      const questionIdx = Number.parseInt(input.dataset.questionIdx || "", 10);
      if (Number.isNaN(questionIdx) || !state.questions[questionIdx]) {
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (!input.value.trim()) {
          return;
        }

        dispatch({ type: "setOtherText", questionIdx, value: input.value });
        const question = state.questions[questionIdx];
        const shouldFocusSubmitNav = Boolean(
          question &&
          !question.multiSelect &&
          questionIdx === state.questions.length - 1,
        );
        dispatch(
          { type: "commitOtherInput", questionIdx },
          { focusNav: shouldFocusSubmitNav },
        );
        return;
      }

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.key === "ArrowUp" ? -1 : 1;
        dispatch({ type: "moveOptionForQuestion", questionIdx, delta });
        const question = state.questions[questionIdx];
        const optionIdx = state.activeOptionIndexByQuestion[questionIdx] ?? 0;
        if (question && optionIdx === question.options.length) {
          const nextInput = stageEl.querySelector(
            ".question-other-input",
          ) as HTMLInputElement | null;
          if (nextInput) {
            nextInput.focus();
            const len = nextInput.value.length;
            nextInput.setSelectionRange(len, len);
          }
        }
        return;
      }

      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        moveNav(e.shiftKey ? -1 : 1);
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
      }
    },
    { signal: listenersAbortController.signal },
  );

  const keyHandler = (e: KeyboardEvent) => {
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl?.classList.contains("question-other-input")) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
      return;
    }

    if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      moveNav(-1);
      return;
    }

    if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      moveNav(1);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActiveOption(-1);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActiveOption(1);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const submitNavIndex = state.questions.length;
      if (state.activeNavIndex === submitNavIndex) {
        dispatch({ type: "attemptSubmit" }, { focusNav: true });
        return;
      }

      if (state.isReviewMode) {
        dispatch({ type: "setNavIndex", navIndex: submitNavIndex });
        dispatch({ type: "attemptSubmit" }, { focusNav: true });
        return;
      }

      const optionIdx =
        state.activeOptionIndexByQuestion[state.activeQuestionIndex] ?? 0;
      activateOption(optionIdx);
    }
  };
  document.addEventListener("keydown", keyHandler, {
    signal: listenersAbortController.signal,
  });

  renderPanelState();
}
