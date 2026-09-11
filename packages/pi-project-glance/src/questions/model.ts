// Public UI projection. The ask_user facade remains the sole model-facing tool.
export const MAX_PENDING_QUESTIONS = 4;
export const MAX_QUESTION_BYTES = 8 * 1024;
export const MAX_ANSWER_BYTES = 4 * 1024;
export const QUESTION_ENTRY_TYPE = "pi-project-glance/question-v1";
export const QUESTION_ANSWER_MESSAGE_TYPE = "pi-project-glance/question-answer-v1";

export interface ProjectGlanceQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ProjectGlanceQuestionResponse {
  kind: "text" | "single" | "multiple" | "single_or_text" | "multiple_or_text";
  options?: ProjectGlanceQuestionOption[];
}

export interface ProjectGlanceQuestionAnswer {
  optionIds: string[];
  text?: string;
}

export interface ProjectGlanceQuestionAttention {
  questionId: string;
  displayId: string;
  revision: number;
  state: "submitted" | "delivery_failed";
  retryAvailable: boolean;
  message: string;
}

export interface ProjectGlanceQuestion {
  id: string;
  displayId: string;
  revision: number;
  state: "pending" | "submitted" | "delivery_failed";
  question: string;
  reason: string;
  response: ProjectGlanceQuestionResponse;
  recommendation?: string;
  recommendedOptionIds?: string[];
  recommendedText?: string;
  temporaryDefault?: { optionIds: string[]; disclosure: string };
  answer?: ProjectGlanceQuestionAnswer;
  failure?: string;
}

export type ProjectGlanceQuestionAction =
  | { type: "question_answer"; questionId: string; expectedRevision: number; answer: ProjectGlanceQuestionAnswer }
  | { type: "question_dismiss" | "question_cancel"; questionId: string; expectedRevision: number }
  | { type: "question_hide"; questionId: string; expectedRevision: number }
  | { type: "question_retry"; questionId: string; expectedRevision: number };
