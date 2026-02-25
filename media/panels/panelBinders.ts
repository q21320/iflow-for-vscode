import type { AppHost } from '../eventBinder';

let questionListenersAbortController: AbortController | null = null;

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

  questionListenersAbortController?.abort();
  const listenersAbortController = new AbortController();
  questionListenersAbortController = listenersAbortController;

  const panel = document.querySelector('.question-panel') as HTMLElement | null;
  if (!panel) {
    return;
  }

  const navEl = panel.querySelector('.question-nav') as HTMLElement | null;
  const stageEl = panel.querySelector('.question-stage') as HTMLElement | null;
  const reviewEl = panel.querySelector('.question-review') as HTMLElement | null;
  const submitErrorEl = panel.querySelector('.question-submit-error') as HTMLElement | null;
  if (!navEl || !stageEl || !reviewEl || !submitErrorEl) {
    return;
  }

  const questionCount = pq.questions.length;
  const submitNavIndex = questionCount;
  let activeQuestionIndex = 0;
  let activeNavIndex = questionCount > 0 ? 0 : submitNavIndex;
  const activeOptionIndexByQuestion = pq.questions.map(() => 0);
  const selectedOptionLabelsByQuestion = pq.questions.map(() => new Set<string>());
  const otherTextByQuestion = pq.questions.map(() => '');
  let isReviewMode = false;
  let showSubmitError = false;

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

  const getSingleSelectedLabel = (questionIdx: number): string => {
    const selected = selectedOptionLabelsByQuestion[questionIdx];
    const value = selected.values().next().value;
    return typeof value === 'string' ? value : '';
  };

  const getOtherValue = (questionIdx: number): string => otherTextByQuestion[questionIdx].trim();

  const getMultiValues = (questionIdx: number): string[] => {
    const values = Array.from(selectedOptionLabelsByQuestion[questionIdx]);
    const otherValue = getOtherValue(questionIdx);
    if (otherValue) {
      values.push(otherValue);
    }
    return values;
  };

  const isAnswered = (questionIdx: number): boolean => {
    if (questionIdx < 0 || questionIdx >= questionCount) {
      return false;
    }

    const q = pq.questions[questionIdx];
    if (q.multiSelect) {
      return getMultiValues(questionIdx).length > 0;
    }

    return Boolean(getOtherValue(questionIdx) || getSingleSelectedLabel(questionIdx));
  };

  const allAnswered = (): boolean => questionCount > 0 && pq.questions.every((_q, qIdx) => isAnswered(qIdx));

  const buildPayload = (): Record<string, string | string[]> => {
    const answers: Record<string, string | string[]> = {};
    for (let qIdx = 0; qIdx < questionCount; qIdx += 1) {
      const q = pq.questions[qIdx];
      if (q.multiSelect) {
        answers[q.header] = getMultiValues(qIdx);
      } else {
        answers[q.header] = getOtherValue(qIdx) || getSingleSelectedLabel(qIdx) || '';
      }
    }
    return answers;
  };

  const questionOptionCount = (questionIdx: number): number => {
    if (questionIdx < 0 || questionIdx >= questionCount) {
      return 0;
    }
    return pq.questions[questionIdx].options.length + 1;
  };

  const clampActiveOptionIndex = (questionIdx: number): void => {
    const totalOptions = questionOptionCount(questionIdx);
    if (totalOptions === 0) {
      return;
    }
    const maxIndex = totalOptions - 1;
    activeOptionIndexByQuestion[questionIdx] = Math.min(
      Math.max(activeOptionIndexByQuestion[questionIdx], 0),
      maxIndex,
    );
  };

  const refreshNav = (): void => {
    const canSubmit = allAnswered();
    navEl.querySelectorAll('.question-nav-item').forEach((item, idx) => {
      const navItem = item as HTMLButtonElement;
      navItem.classList.toggle('active', idx === activeNavIndex);
      navItem.classList.toggle('answered', idx < questionCount && isAnswered(idx));
      navItem.classList.toggle('disabled', idx === submitNavIndex && !canSubmit);
    });

    submitErrorEl.textContent = showSubmitError ? 'Please answer every question before submitting.' : '';
    submitErrorEl.classList.toggle('visible', showSubmitError);
  };

  const renderReviewStage = (): void => {
    reviewEl.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'question-review-title';
    title.textContent = 'Review your answers';
    reviewEl.appendChild(title);

    const list = document.createElement('div');
    list.className = 'question-review-list';

    for (let qIdx = 0; qIdx < questionCount; qIdx += 1) {
      const q = pq.questions[qIdx];
      const row = document.createElement('div');
      row.className = 'review-row';

      const questionText = document.createElement('div');
      questionText.className = 'review-question';
      questionText.textContent = `- ${q.question}`;

      const answerText = document.createElement('div');
      answerText.className = 'review-answer';
      if (q.multiSelect) {
        const values = getMultiValues(qIdx);
        answerText.textContent = `-> ${values.join(', ') || '(No answer)'}`;
      } else {
        answerText.textContent = `-> ${getOtherValue(qIdx) || getSingleSelectedLabel(qIdx) || '(No answer)'}`;
      }

      row.appendChild(questionText);
      row.appendChild(answerText);
      list.appendChild(row);
    }

    reviewEl.appendChild(list);

    const ready = document.createElement('div');
    ready.className = 'question-review-ready';
    ready.textContent = 'Ready to submit your answers?';
    reviewEl.appendChild(ready);
  };

  const renderQuestionStage = (): void => {
    stageEl.innerHTML = '';

    if (questionCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'question-empty';
      empty.textContent = 'No questions to answer. Press Esc to cancel.';
      stageEl.appendChild(empty);
      return;
    }

    const q = pq.questions[activeQuestionIndex];
    clampActiveOptionIndex(activeQuestionIndex);
    const focusedOptionIdx = activeOptionIndexByQuestion[activeQuestionIndex];

    const questionText = document.createElement('div');
    questionText.className = 'question-text';
    questionText.textContent = q.question;
    stageEl.appendChild(questionText);

    const subtitle = document.createElement('div');
    subtitle.className = 'question-subtitle';
    subtitle.textContent = `Question ${activeQuestionIndex + 1} of ${questionCount}${q.multiSelect ? ' · Select one or more' : ''}`;
    stageEl.appendChild(subtitle);

    const optionsWrap = document.createElement('div');
    optionsWrap.className = 'approval-options question-options-list';

    q.options.forEach((opt, optionIdx) => {
      const optionButton = document.createElement('button');
      optionButton.className = 'approval-option question-option';
      optionButton.type = 'button';
      optionButton.dataset.optionIdx = String(optionIdx);

      if (selectedOptionLabelsByQuestion[activeQuestionIndex].has(opt.label)) {
        optionButton.classList.add('selected');
      }
      if (focusedOptionIdx === optionIdx) {
        optionButton.classList.add('focused');
      }

      const key = document.createElement('span');
      key.className = 'approval-key';
      key.textContent = String(optionIdx + 1);
      optionButton.appendChild(key);

      const label = document.createElement('span');
      label.className = 'approval-label';
      label.textContent = opt.label;
      optionButton.appendChild(label);

      if (opt.description) {
        const description = document.createElement('span');
        description.className = 'option-description';
        description.textContent = opt.description;
        optionButton.appendChild(description);
      }

      optionsWrap.appendChild(optionButton);
    });

    const otherIndex = q.options.length;
    const otherRow = document.createElement('div');
    otherRow.className = 'approval-option question-option question-other-row';
    otherRow.dataset.optionIdx = String(otherIndex);
    if (focusedOptionIdx === otherIndex) {
      otherRow.classList.add('focused');
    }
    if (getOtherValue(activeQuestionIndex)) {
      otherRow.classList.add('selected');
    }

    const otherKey = document.createElement('span');
    otherKey.className = 'approval-key';
    otherKey.textContent = String(otherIndex + 1);
    otherRow.appendChild(otherKey);

    const otherInput = document.createElement('input');
    otherInput.type = 'text';
    otherInput.className = 'approval-feedback-input question-other-input';
    otherInput.dataset.questionIdx = String(activeQuestionIndex);
    otherInput.placeholder = 'Other...';
    otherInput.value = otherTextByQuestion[activeQuestionIndex];
    otherRow.appendChild(otherInput);

    optionsWrap.appendChild(otherRow);
    stageEl.appendChild(optionsWrap);
  };

  const focusActiveNavItem = (): void => {
    const navButton = navEl.querySelector(`[data-nav-idx="${activeNavIndex}"]`) as HTMLButtonElement | null;
    navButton?.focus();
  };

  const renderPanelState = (focusNav = false): void => {
    refreshNav();
    if (isReviewMode) {
      stageEl.classList.remove('is-visible');
      reviewEl.classList.add('is-visible');
      renderReviewStage();
    } else {
      reviewEl.classList.remove('is-visible');
      stageEl.classList.add('is-visible');
      renderQuestionStage();
    }
    if (focusNav) {
      focusActiveNavItem();
    }
  };

  const activateSubmit = (focusNav = false): void => {
    if (!allAnswered()) {
      showSubmitError = true;
      isReviewMode = false;
      renderPanelState(focusNav);
      return;
    }

    showSubmitError = false;
    if (!isReviewMode) {
      isReviewMode = true;
      renderPanelState(focusNav);
      return;
    }

    handleSubmitAnswers(buildPayload());
  };

  const activateOption = (optionIdx: number): void => {
    if (questionCount === 0) {
      return;
    }

    const qIdx = activeQuestionIndex;
    const q = pq.questions[qIdx];
    const otherIdx = q.options.length;
    activeOptionIndexByQuestion[qIdx] = optionIdx;
    showSubmitError = false;

    if (optionIdx === otherIdx) {
      renderPanelState();
      const input = stageEl.querySelector('.question-other-input') as HTMLInputElement | null;
      if (input) {
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
      return;
    }

    const option = q.options[optionIdx];
    if (!option) {
      return;
    }

    if (q.multiSelect) {
      const selected = selectedOptionLabelsByQuestion[qIdx];
      if (selected.has(option.label)) {
        selected.delete(option.label);
      } else {
        selected.add(option.label);
      }
      renderPanelState();
      return;
    }

    selectedOptionLabelsByQuestion[qIdx].clear();
    selectedOptionLabelsByQuestion[qIdx].add(option.label);
    otherTextByQuestion[qIdx] = '';

    if (qIdx < questionCount - 1) {
      activeQuestionIndex = qIdx + 1;
      activeNavIndex = activeQuestionIndex;
      isReviewMode = false;
    } else {
      activeNavIndex = submitNavIndex;
      isReviewMode = allAnswered();
    }
    renderPanelState(activeNavIndex === submitNavIndex);
  };

  const moveNav = (delta: number): void => {
    const totalNavItems = questionCount + 1;
    if (totalNavItems <= 0) {
      return;
    }

    activeNavIndex = (activeNavIndex + delta + totalNavItems) % totalNavItems;
    showSubmitError = false;

    if (activeNavIndex < questionCount) {
      activeQuestionIndex = activeNavIndex;
      isReviewMode = false;
      renderPanelState(true);
      return;
    }

    if (allAnswered()) {
      isReviewMode = true;
    } else {
      isReviewMode = false;
      showSubmitError = true;
    }
    renderPanelState(true);
  };

  const moveActiveOption = (delta: number): void => {
    if (questionCount === 0 || isReviewMode || activeNavIndex >= questionCount) {
      return;
    }

    const totalOptions = questionOptionCount(activeQuestionIndex);
    if (totalOptions <= 0) {
      return;
    }

    activeOptionIndexByQuestion[activeQuestionIndex] =
      (activeOptionIndexByQuestion[activeQuestionIndex] + delta + totalOptions) % totalOptions;
    showSubmitError = false;
    renderPanelState();
  };

  panel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) {
      return;
    }

    const navButton = target.closest('.question-nav-item') as HTMLButtonElement | null;
    if (navButton && navEl.contains(navButton)) {
      const navIdx = Number.parseInt(navButton.dataset.navIdx || '', 10);
      if (Number.isNaN(navIdx)) {
        return;
      }

      activeNavIndex = navIdx;
      if (navIdx < questionCount) {
        activeQuestionIndex = navIdx;
        isReviewMode = false;
        showSubmitError = false;
        renderPanelState();
      } else {
        activateSubmit(true);
      }
      return;
    }

    const optionRow = target.closest('.question-option[data-option-idx]') as HTMLElement | null;
    if (optionRow && stageEl.contains(optionRow)) {
      const optionIdx = Number.parseInt(optionRow.dataset.optionIdx || '', 10);
      if (!Number.isNaN(optionIdx)) {
        activateOption(optionIdx);
      }
    }
  }, { signal: listenersAbortController.signal });

  panel.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement | null;
    if (!input || !input.classList.contains('question-other-input')) {
      return;
    }

    const qIdx = Number.parseInt(input.dataset.questionIdx || '', 10);
    if (Number.isNaN(qIdx) || qIdx < 0 || qIdx >= questionCount) {
      return;
    }

    otherTextByQuestion[qIdx] = input.value;
    showSubmitError = false;
    refreshNav();
    const otherRow = input.closest('.question-other-row');
    otherRow?.classList.toggle('selected', getOtherValue(qIdx).length > 0);
  }, { signal: listenersAbortController.signal });

  panel.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement | null;
    if (!input || !input.classList.contains('question-other-input')) {
      return;
    }

    const qIdx = Number.parseInt(input.dataset.questionIdx || '', 10);
    if (Number.isNaN(qIdx) || qIdx < 0 || qIdx >= questionCount) {
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const value = input.value.trim();
      if (!value) {
        return;
      }

      otherTextByQuestion[qIdx] = value;
      showSubmitError = false;
      if (!pq.questions[qIdx].multiSelect) {
        selectedOptionLabelsByQuestion[qIdx].clear();
        if (qIdx < questionCount - 1) {
          activeQuestionIndex = qIdx + 1;
          activeNavIndex = activeQuestionIndex;
          isReviewMode = false;
        } else {
          activeNavIndex = submitNavIndex;
          isReviewMode = allAnswered();
        }
      }
      renderPanelState(activeNavIndex === submitNavIndex);
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const totalOptions = questionOptionCount(qIdx);
      if (totalOptions === 0) {
        return;
      }
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      activeOptionIndexByQuestion[qIdx] = (activeOptionIndexByQuestion[qIdx] + delta + totalOptions) % totalOptions;
      renderPanelState();
      if (activeOptionIndexByQuestion[qIdx] === pq.questions[qIdx].options.length) {
        const nextInput = stageEl.querySelector('.question-other-input') as HTMLInputElement | null;
        if (nextInput) {
          nextInput.focus();
          const len = nextInput.value.length;
          nextInput.setSelectionRange(len, len);
        }
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      moveNav(e.shiftKey ? -1 : 1);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
    }
  }, { signal: listenersAbortController.signal });

  const keyHandler = (e: KeyboardEvent) => {
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl?.classList.contains('question-other-input')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
      return;
    }

    if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      moveNav(-1);
      return;
    }

    if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      moveNav(1);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActiveOption(-1);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActiveOption(1);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeNavIndex === submitNavIndex) {
        activateSubmit(true);
        return;
      }

      if (isReviewMode) {
        activeNavIndex = submitNavIndex;
        activateSubmit(true);
        return;
      }

      const optionIdx = activeOptionIndexByQuestion[activeQuestionIndex];
      activateOption(optionIdx);
    }
  };
  document.addEventListener('keydown', keyHandler, { signal: listenersAbortController.signal });

  const observer = new MutationObserver(() => {
    if (!document.body.contains(panel)) {
      listenersAbortController.abort();
      observer.disconnect();
      if (questionListenersAbortController === listenersAbortController) {
        questionListenersAbortController = null;
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  listenersAbortController.signal.addEventListener('abort', () => {
    observer.disconnect();
    if (questionListenersAbortController === listenersAbortController) {
      questionListenersAbortController = null;
    }
  }, { once: true });

  renderPanelState();
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
