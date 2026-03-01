import {
  QuestionAnswerPayload,
  QuestionPanelAction,
  QuestionPanelDerived,
  QuestionPanelQuestion,
  QuestionPanelState,
} from "./questionPanelTypes";

function cloneSelections(selections: string[][]): string[][] {
  return selections.map((entry) => [...entry]);
}

function normalizeNavIndex(index: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return ((index % total) + total) % total;
}

function getQuestionOptionCount(
  state: QuestionPanelState,
  questionIdx: number,
): number {
  const question = state.questions[questionIdx];
  if (!question) {
    return 0;
  }
  return question.options.length + 1;
}

function clampOptionIndex(
  state: QuestionPanelState,
  questionIdx: number,
): number {
  const total = getQuestionOptionCount(state, questionIdx);
  if (total <= 0) {
    return 0;
  }

  const current = state.activeOptionIndexByQuestion[questionIdx] ?? 0;
  return Math.min(Math.max(current, 0), total - 1);
}

function trimOtherValue(
  state: QuestionPanelState,
  questionIdx: number,
): string {
  return (state.otherTextByQuestion[questionIdx] ?? "").trim();
}

function getSingleSelectedLabel(
  state: QuestionPanelState,
  questionIdx: number,
): string {
  const selected = state.selectedOptionLabelsByQuestion[questionIdx];
  if (!selected || selected.length === 0) {
    return "";
  }
  return selected[0] ?? "";
}

function getMultiValues(
  state: QuestionPanelState,
  questionIdx: number,
): string[] {
  const values = [...(state.selectedOptionLabelsByQuestion[questionIdx] ?? [])];
  const otherValue = trimOtherValue(state, questionIdx);
  if (otherValue) {
    values.push(otherValue);
  }
  return values;
}

export function isQuestionAnswered(
  state: QuestionPanelState,
  questionIdx: number,
): boolean {
  const question = state.questions[questionIdx];
  if (!question) {
    return false;
  }

  if (question.multiSelect) {
    return getMultiValues(state, questionIdx).length > 0;
  }

  return Boolean(
    trimOtherValue(state, questionIdx) ||
    getSingleSelectedLabel(state, questionIdx),
  );
}

export function canSubmitAnswers(state: QuestionPanelState): boolean {
  return (
    state.questions.length > 0 &&
    state.questions.every((_, idx) => isQuestionAnswered(state, idx))
  );
}

export function createQuestionPanelState(
  questions: QuestionPanelQuestion[],
): QuestionPanelState {
  const questionCount = questions.length;
  const submitNavIndex = questionCount;
  const initialNavIndex = questionCount > 0 ? 0 : submitNavIndex;

  return {
    questions,
    activeQuestionIndex: 0,
    activeNavIndex: initialNavIndex,
    activeOptionIndexByQuestion: questions.map(() => 0),
    selectedOptionLabelsByQuestion: questions.map(() => []),
    otherTextByQuestion: questions.map(() => ""),
    isReviewMode: false,
    showSubmitError: false,
  };
}

export function deriveQuestionPanelState(
  state: QuestionPanelState,
): QuestionPanelDerived {
  const questionCount = state.questions.length;
  const submitNavIndex = questionCount;
  const answeredByQuestion = state.questions.map((_question, idx) =>
    isQuestionAnswered(state, idx),
  );
  const activeQuestion = state.questions[state.activeQuestionIndex] ?? null;
  const activeOptionIndex = activeQuestion
    ? clampOptionIndex(state, state.activeQuestionIndex)
    : 0;

  return {
    questionCount,
    submitNavIndex,
    answeredByQuestion,
    canSubmit: questionCount > 0 && answeredByQuestion.every(Boolean),
    activeQuestion,
    activeOptionIndex,
  };
}

function applyActivateOption(
  state: QuestionPanelState,
  optionIdx: number,
): QuestionPanelState {
  const question = state.questions[state.activeQuestionIndex];
  if (!question) {
    return state;
  }

  const totalOptions = question.options.length + 1;
  if (optionIdx < 0 || optionIdx >= totalOptions) {
    return state;
  }

  const nextOptionIndexes = [...state.activeOptionIndexByQuestion];
  nextOptionIndexes[state.activeQuestionIndex] = optionIdx;

  const baseState: QuestionPanelState = {
    ...state,
    activeOptionIndexByQuestion: nextOptionIndexes,
    showSubmitError: false,
  };

  const otherIdx = question.options.length;
  if (optionIdx === otherIdx) {
    return baseState;
  }

  const option = question.options[optionIdx];
  if (!option) {
    return baseState;
  }

  if (question.multiSelect) {
    const nextSelections = cloneSelections(
      baseState.selectedOptionLabelsByQuestion,
    );
    const selected = nextSelections[state.activeQuestionIndex];
    if (!selected) {
      return baseState;
    }
    const existingIdx = selected.indexOf(option.label);
    if (existingIdx >= 0) {
      selected.splice(existingIdx, 1);
    } else {
      selected.push(option.label);
    }

    return {
      ...baseState,
      selectedOptionLabelsByQuestion: nextSelections,
    };
  }

  const nextSelections = cloneSelections(
    baseState.selectedOptionLabelsByQuestion,
  );
  nextSelections[state.activeQuestionIndex] = [option.label];
  const nextOtherTexts = [...baseState.otherTextByQuestion];
  nextOtherTexts[state.activeQuestionIndex] = "";

  let nextState: QuestionPanelState = {
    ...baseState,
    selectedOptionLabelsByQuestion: nextSelections,
    otherTextByQuestion: nextOtherTexts,
  };

  if (state.activeQuestionIndex < state.questions.length - 1) {
    nextState = {
      ...nextState,
      activeQuestionIndex: state.activeQuestionIndex + 1,
      activeNavIndex: state.activeQuestionIndex + 1,
      isReviewMode: false,
    };
    return nextState;
  }

  nextState = {
    ...nextState,
    activeNavIndex: state.questions.length,
  };

  return {
    ...nextState,
    isReviewMode: canSubmitAnswers(nextState),
  };
}

function applySetOtherText(
  state: QuestionPanelState,
  questionIdx: number,
  value: string,
): QuestionPanelState {
  if (!state.questions[questionIdx]) {
    return state;
  }

  const nextOther = [...state.otherTextByQuestion];
  nextOther[questionIdx] = value;

  return {
    ...state,
    otherTextByQuestion: nextOther,
    showSubmitError: false,
  };
}

function applyCommitOtherInput(
  state: QuestionPanelState,
  questionIdx: number,
): QuestionPanelState {
  const question = state.questions[questionIdx];
  if (!question) {
    return state;
  }

  const value = trimOtherValue(state, questionIdx);
  if (!value) {
    return state;
  }

  let nextState = applySetOtherText(state, questionIdx, value);
  if (question.multiSelect) {
    return nextState;
  }

  const nextSelections = cloneSelections(
    nextState.selectedOptionLabelsByQuestion,
  );
  nextSelections[questionIdx] = [];
  nextState = {
    ...nextState,
    selectedOptionLabelsByQuestion: nextSelections,
  };

  if (questionIdx < state.questions.length - 1) {
    return {
      ...nextState,
      activeQuestionIndex: questionIdx + 1,
      activeNavIndex: questionIdx + 1,
      isReviewMode: false,
    };
  }

  const reviewCandidate: QuestionPanelState = {
    ...nextState,
    activeNavIndex: state.questions.length,
  };

  return {
    ...reviewCandidate,
    isReviewMode: canSubmitAnswers(reviewCandidate),
  };
}

function applyMoveNav(
  state: QuestionPanelState,
  delta: number,
): QuestionPanelState {
  const totalNavItems = state.questions.length + 1;
  if (totalNavItems <= 0) {
    return state;
  }

  const nextNav = normalizeNavIndex(
    state.activeNavIndex + delta,
    totalNavItems,
  );
  if (nextNav < state.questions.length) {
    return {
      ...state,
      activeNavIndex: nextNav,
      activeQuestionIndex: nextNav,
      isReviewMode: false,
      showSubmitError: false,
    };
  }

  const nextState: QuestionPanelState = {
    ...state,
    activeNavIndex: nextNav,
    showSubmitError: false,
  };

  if (canSubmitAnswers(nextState)) {
    return {
      ...nextState,
      isReviewMode: true,
    };
  }

  return {
    ...nextState,
    isReviewMode: false,
    showSubmitError: true,
  };
}

function applySetNavIndex(
  state: QuestionPanelState,
  navIndex: number,
): QuestionPanelState {
  const totalNavItems = state.questions.length + 1;
  if (totalNavItems <= 0) {
    return state;
  }

  const nextNav = normalizeNavIndex(navIndex, totalNavItems);
  if (nextNav < state.questions.length) {
    return {
      ...state,
      activeNavIndex: nextNav,
      activeQuestionIndex: nextNav,
      isReviewMode: false,
      showSubmitError: false,
    };
  }

  return {
    ...state,
    activeNavIndex: nextNav,
  };
}

function applyMoveOptionForQuestion(
  state: QuestionPanelState,
  questionIdx: number,
  delta: number,
): QuestionPanelState {
  if (!state.questions[questionIdx]) {
    return state;
  }

  const totalOptions = getQuestionOptionCount(state, questionIdx);
  if (totalOptions <= 0) {
    return state;
  }

  const nextOptionIndexes = [...state.activeOptionIndexByQuestion];
  const current = nextOptionIndexes[questionIdx] ?? 0;
  nextOptionIndexes[questionIdx] = normalizeNavIndex(
    current + delta,
    totalOptions,
  );

  return {
    ...state,
    activeOptionIndexByQuestion: nextOptionIndexes,
    showSubmitError: false,
  };
}

function applyAttemptSubmit(state: QuestionPanelState): QuestionPanelState {
  if (!canSubmitAnswers(state)) {
    return {
      ...state,
      isReviewMode: false,
      showSubmitError: true,
    };
  }

  if (!state.isReviewMode) {
    return {
      ...state,
      isReviewMode: true,
      showSubmitError: false,
    };
  }

  return state;
}

export function reduceQuestionPanelState(
  state: QuestionPanelState,
  action: QuestionPanelAction,
): QuestionPanelState {
  switch (action.type) {
    case "activateOption":
      return applyActivateOption(state, action.optionIdx);

    case "setOtherText":
      return applySetOtherText(state, action.questionIdx, action.value);

    case "commitOtherInput":
      return applyCommitOtherInput(state, action.questionIdx);

    case "moveNav":
      return applyMoveNav(state, action.delta);

    case "setNavIndex":
      return applySetNavIndex(state, action.navIndex);

    case "moveOption":
      return applyMoveOptionForQuestion(
        state,
        state.activeQuestionIndex,
        action.delta,
      );

    case "moveOptionForQuestion":
      return applyMoveOptionForQuestion(
        state,
        action.questionIdx,
        action.delta,
      );

    case "attemptSubmit":
      return applyAttemptSubmit(state);

    default:
      return state;
  }
}

export function shouldSubmitAnswers(
  previousState: QuestionPanelState,
  nextState: QuestionPanelState,
): boolean {
  if (!previousState.isReviewMode || !nextState.isReviewMode) {
    return false;
  }
  if (nextState.showSubmitError) {
    return false;
  }
  return canSubmitAnswers(nextState);
}

export function buildQuestionAnswerPayload(
  state: QuestionPanelState,
): QuestionAnswerPayload {
  const answers: QuestionAnswerPayload = {};

  state.questions.forEach((question, qIdx) => {
    if (question.multiSelect) {
      answers[question.header] = getMultiValues(state, qIdx);
      return;
    }
    answers[question.header] =
      trimOtherValue(state, qIdx) || getSingleSelectedLabel(state, qIdx) || "";
  });

  return answers;
}

export function buildCancelledQuestionAnswerPayload(
  questions: QuestionPanelQuestion[],
): QuestionAnswerPayload {
  const answers: QuestionAnswerPayload = {};
  questions.forEach((question) => {
    answers[question.header] = "";
  });
  return answers;
}
