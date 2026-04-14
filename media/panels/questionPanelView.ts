import { deriveQuestionPanelState } from '../../src/shared/questionPanelState';
import { QuestionPanelState } from '../../src/shared/questionPanelTypes';

export function renderQuestionPanelNav(
  navEl: HTMLElement,
  submitErrorEl: HTMLElement,
  state: QuestionPanelState,
): void {
  const derived = deriveQuestionPanelState(state);

  navEl.querySelectorAll('.question-nav-item').forEach((item, idx) => {
    const navItem = item as HTMLButtonElement;
    navItem.classList.toggle('active', idx === state.activeNavIndex);
    navItem.classList.toggle('answered', idx < derived.questionCount && derived.answeredByQuestion[idx]);
    navItem.classList.toggle('disabled', idx === derived.submitNavIndex && !derived.canSubmit);
  });

  submitErrorEl.textContent = state.showSubmitError
    ? 'Please answer every question before submitting.'
    : '';
  submitErrorEl.classList.toggle('visible', state.showSubmitError);
}

export function renderQuestionStage(stageEl: HTMLElement, state: QuestionPanelState): void {
  stageEl.innerHTML = '';
  const derived = deriveQuestionPanelState(state);
  const question = derived.activeQuestion;
  if (!question) {
    const empty = document.createElement('div');
    empty.className = 'question-empty';
    empty.textContent = '没有题目了。按 Esc 键取消。';
    stageEl.appendChild(empty);
    return;
  }

  const questionText = document.createElement('div');
  questionText.className = 'question-text';
  questionText.textContent = question.question;
  stageEl.appendChild(questionText);

  const subtitle = document.createElement('div');
  subtitle.className = 'question-subtitle';
  subtitle.textContent =
    `Question ${state.activeQuestionIndex + 1} of ${derived.questionCount}` +
    `${question.multiSelect ? ' · Select one or more' : ''}`;
  stageEl.appendChild(subtitle);

  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'approval-options question-options-list';

  question.options.forEach((opt, optionIdx) => {
    const optionButton = document.createElement('button');
    optionButton.className = 'approval-option question-option';
    optionButton.type = 'button';
    optionButton.dataset.optionIdx = String(optionIdx);

    const selected = state.selectedOptionLabelsByQuestion[state.activeQuestionIndex] ?? [];
    if (selected.includes(opt.label)) {
      optionButton.classList.add('selected');
    }
    if (derived.activeOptionIndex === optionIdx) {
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

  const otherIndex = question.options.length;
  const otherRow = document.createElement('div');
  otherRow.className = 'approval-option question-option question-other-row';
  otherRow.dataset.optionIdx = String(otherIndex);
  if (derived.activeOptionIndex === otherIndex) {
    otherRow.classList.add('focused');
  }

  const otherValue = state.otherTextByQuestion[state.activeQuestionIndex] ?? '';
  if (otherValue.trim()) {
    otherRow.classList.add('selected');
  }

  const otherKey = document.createElement('span');
  otherKey.className = 'approval-key';
  otherKey.textContent = String(otherIndex + 1);
  otherRow.appendChild(otherKey);

  const otherInput = document.createElement('input');
  otherInput.type = 'text';
  otherInput.className = 'approval-feedback-input question-other-input';
  otherInput.dataset.questionIdx = String(state.activeQuestionIndex);
  otherInput.placeholder = 'Other...';
  otherInput.value = otherValue;
  otherRow.appendChild(otherInput);

  optionsWrap.appendChild(otherRow);
  stageEl.appendChild(optionsWrap);
}

export function renderQuestionReviewStage(reviewEl: HTMLElement, state: QuestionPanelState): void {
  reviewEl.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'question-review-title';
  title.textContent = 'Review your answers';
  reviewEl.appendChild(title);

  const list = document.createElement('div');
  list.className = 'question-review-list';

  state.questions.forEach((question, qIdx) => {
    const row = document.createElement('div');
    row.className = 'review-row';

    const questionText = document.createElement('div');
    questionText.className = 'review-question';
    questionText.textContent = `- ${question.question}`;

    const answerText = document.createElement('div');
    answerText.className = 'review-answer';

    if (question.multiSelect) {
      const selected = [...(state.selectedOptionLabelsByQuestion[qIdx] ?? [])];
      const otherValue = (state.otherTextByQuestion[qIdx] ?? '').trim();
      if (otherValue) {
        selected.push(otherValue);
      }
      answerText.textContent = `-> ${selected.join(', ') || '(No answer)'}`;
    } else {
      const selected = state.selectedOptionLabelsByQuestion[qIdx]?.[0] ?? '';
      const otherValue = (state.otherTextByQuestion[qIdx] ?? '').trim();
      answerText.textContent = `-> ${otherValue || selected || '(No answer)'}`;
    }

    row.appendChild(questionText);
    row.appendChild(answerText);
    list.appendChild(row);
  });

  reviewEl.appendChild(list);

  const ready = document.createElement('div');
  ready.className = 'question-review-ready';
  ready.textContent = 'Ready to submit your answers?';
  reviewEl.appendChild(ready);
}

export function focusQuestionNavItem(navEl: HTMLElement, navIndex: number): void {
  const navButton = navEl.querySelector(`[data-nav-idx="${navIndex}"]`) as HTMLButtonElement | null;
  navButton?.focus();
}
