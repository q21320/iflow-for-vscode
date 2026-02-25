import * as assert from 'assert';
import {
  buildCancelledQuestionAnswerPayload,
  buildQuestionAnswerPayload,
  createQuestionPanelState,
  deriveQuestionPanelState,
  reduceQuestionPanelState,
  shouldSubmitAnswers,
} from '../shared/questionPanelState';
import type { QuestionPanelQuestion } from '../shared/questionPanelTypes';

const SAMPLE_QUESTIONS: QuestionPanelQuestion[] = [
  {
    header: 'Color',
    question: 'Choose a color',
    multiSelect: false,
    options: [
      { label: 'Red', description: 'Warm' },
      { label: 'Blue', description: 'Cool' },
    ],
  },
  {
    header: 'Size',
    question: 'Choose a size',
    multiSelect: false,
    options: [
      { label: 'S', description: 'Small' },
      { label: 'L', description: 'Large' },
    ],
  },
];

suite('questionPanelState', () => {
  test('single select advances and builds payload', () => {
    let state = createQuestionPanelState(SAMPLE_QUESTIONS);
    state = reduceQuestionPanelState(state, { type: 'activateOption', optionIdx: 1 });
    assert.strictEqual(state.activeQuestionIndex, 1);
    assert.strictEqual(state.activeNavIndex, 1);
    assert.strictEqual(state.isReviewMode, false);

    state = reduceQuestionPanelState(state, { type: 'activateOption', optionIdx: 0 });
    assert.strictEqual(state.activeNavIndex, SAMPLE_QUESTIONS.length);
    assert.strictEqual(state.isReviewMode, true);

    assert.deepStrictEqual(buildQuestionAnswerPayload(state), {
      Color: 'Blue',
      Size: 'S',
    });
  });

  test('multi select payload includes selected labels and other input', () => {
    const questions: QuestionPanelQuestion[] = [
      {
        header: 'Tags',
        question: 'Pick tags',
        multiSelect: true,
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
      },
    ];

    let state = createQuestionPanelState(questions);
    state = reduceQuestionPanelState(state, { type: 'activateOption', optionIdx: 0 });
    state = reduceQuestionPanelState(state, { type: 'activateOption', optionIdx: 1 });
    state = reduceQuestionPanelState(state, { type: 'setOtherText', questionIdx: 0, value: 'C' });

    assert.deepStrictEqual(buildQuestionAnswerPayload(state), {
      Tags: ['A', 'B', 'C'],
    });
  });

  test('single-select other input commits and advances to next question', () => {
    let state = createQuestionPanelState(SAMPLE_QUESTIONS);
    state = reduceQuestionPanelState(state, { type: 'activateOption', optionIdx: SAMPLE_QUESTIONS[0].options.length });
    state = reduceQuestionPanelState(state, { type: 'setOtherText', questionIdx: 0, value: 'Purple' });
    state = reduceQuestionPanelState(state, { type: 'commitOtherInput', questionIdx: 0 });

    assert.strictEqual(state.activeQuestionIndex, 1);
    assert.strictEqual(state.activeNavIndex, 1);
    assert.deepStrictEqual(buildQuestionAnswerPayload(state), {
      Color: 'Purple',
      Size: '',
    });
  });

  test('navigation and option movement wrap correctly', () => {
    let state = createQuestionPanelState(SAMPLE_QUESTIONS);
    state = reduceQuestionPanelState(state, { type: 'moveNav', delta: -1 });
    assert.strictEqual(state.activeNavIndex, SAMPLE_QUESTIONS.length);
    assert.strictEqual(state.showSubmitError, true);

    state = reduceQuestionPanelState(state, { type: 'moveNav', delta: 1 });
    assert.strictEqual(state.activeNavIndex, 0);
    assert.strictEqual(state.activeQuestionIndex, 0);

    state = reduceQuestionPanelState(state, { type: 'moveOption', delta: -1 });
    const derived = deriveQuestionPanelState(state);
    assert.strictEqual(derived.activeOptionIndex, SAMPLE_QUESTIONS[0].options.length);
  });

  test('attempt submit blocks incomplete answers and allows confirmed submit', () => {
    let state = createQuestionPanelState([SAMPLE_QUESTIONS[0]]);
    let next = reduceQuestionPanelState(state, { type: 'attemptSubmit' });
    assert.strictEqual(next.showSubmitError, true);
    assert.strictEqual(shouldSubmitAnswers(state, next), false);

    state = reduceQuestionPanelState(state, { type: 'activateOption', optionIdx: 0 });
    assert.strictEqual(state.isReviewMode, true);
    next = reduceQuestionPanelState(state, { type: 'attemptSubmit' });
    assert.strictEqual(shouldSubmitAnswers(state, next), true);
  });

  test('build cancelled payload maps all headers to empty string', () => {
    assert.deepStrictEqual(buildCancelledQuestionAnswerPayload(SAMPLE_QUESTIONS), {
      Color: '',
      Size: '',
    });
  });
});
