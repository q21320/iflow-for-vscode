import { StreamChunk } from '../protocol';

export type QuestionPanelQuestion = Extract<StreamChunk, { chunkType: 'user_question' }>['questions'][number];

export type QuestionAnswerPayload = Record<string, string | string[]>;

export interface QuestionPanelState {
  readonly questions: QuestionPanelQuestion[];
  readonly activeQuestionIndex: number;
  readonly activeNavIndex: number;
  readonly activeOptionIndexByQuestion: number[];
  readonly selectedOptionLabelsByQuestion: string[][];
  readonly otherTextByQuestion: string[];
  readonly isReviewMode: boolean;
  readonly showSubmitError: boolean;
}

export type QuestionPanelAction =
  | { type: 'activateOption'; optionIdx: number }
  | { type: 'setOtherText'; questionIdx: number; value: string }
  | { type: 'commitOtherInput'; questionIdx: number }
  | { type: 'moveNav'; delta: number }
  | { type: 'setNavIndex'; navIndex: number }
  | { type: 'moveOption'; delta: number }
  | { type: 'moveOptionForQuestion'; questionIdx: number; delta: number }
  | { type: 'attemptSubmit' };

export interface QuestionPanelDerived {
  readonly questionCount: number;
  readonly submitNavIndex: number;
  readonly answeredByQuestion: boolean[];
  readonly canSubmit: boolean;
  readonly activeQuestion: QuestionPanelQuestion | null;
  readonly activeOptionIndex: number;
}
