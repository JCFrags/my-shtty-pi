import { MAX_ANSWER_BYTES, MAX_PENDING_QUESTIONS, MAX_QUESTION_BYTES, type ProjectGlanceQuestionAttention, type ProjectGlanceQuestion, type ProjectGlanceQuestionAction, type ProjectGlanceQuestionAnswer } from "../questions/model.js";

function fail(): never { throw new Error("INVALID_QUESTION"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail();
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > max || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value) || [...value].some((character) => /^[\uD800-\uDFFF]$/u.test(character))) fail();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^qst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) fail();
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail();
  return Number(value);
}
function optionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8 || value.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(item)) || new Set(value).size !== value.length) fail();
  return [...value];
}
export function validateQuestionAnswer(value: unknown): ProjectGlanceQuestionAnswer {
  const source = object(value);
  keys(source, ["optionIds"], ["text"]);
  if (Buffer.byteLength(JSON.stringify(source)) > MAX_ANSWER_BYTES) fail();
  return { optionIds: optionIds(source.optionIds), ...(source.text === undefined ? {} : { text: text(source.text, MAX_ANSWER_BYTES) }) };
}
export function validateQuestionAction(value: unknown): ProjectGlanceQuestionAction {
  const source = object(value);
  if (!["question_answer", "question_dismiss", "question_cancel", "question_hide", "question_retry"].includes(String(source.type))) fail();
  keys(source, ["type", "questionId", "expectedRevision", ...(source.type === "question_answer" ? ["answer"] : [])]);
  const common = { questionId: id(source.questionId), expectedRevision: revision(source.expectedRevision) };
  if (source.type === "question_answer") return { type: "question_answer", ...common, answer: validateQuestionAnswer(source.answer) };
  return { type: source.type as "question_dismiss" | "question_cancel" | "question_hide" | "question_retry", ...common };
}
export function validateQuestionAttention(value: unknown): ProjectGlanceQuestionAttention[] {
  if (!Array.isArray(value) || value.length > MAX_PENDING_QUESTIONS) fail();
  const result = value.map((entry): ProjectGlanceQuestionAttention => {
    const source = object(entry);
    keys(source, ["questionId", "displayId", "revision", "state", "retryAvailable", "message"]);
    if (typeof source.displayId !== "string" || !/^Q-[1-9][0-9]*$/.test(source.displayId) || source.displayId.length > 32) fail();
    if (source.state !== "submitted" && source.state !== "delivery_failed") fail();
    if (typeof source.retryAvailable !== "boolean") fail();
    return { questionId: id(source.questionId), displayId: source.displayId, revision: revision(source.revision), state: source.state, retryAvailable: source.retryAvailable, message: text(source.message, 2048) };
  });
  if (new Set(result.map((entry) => entry.questionId)).size !== result.length) fail();
  return result;
}

export function validateQuestions(value: unknown): ProjectGlanceQuestion[] {
  if (!Array.isArray(value) || value.length > MAX_PENDING_QUESTIONS) fail();
  const result = value.map((entry): ProjectGlanceQuestion => {
    const source = object(entry);
    keys(source, ["id", "displayId", "revision", "state", "question", "reason", "response"], ["recommendation", "recommendedOptionIds", "recommendedText", "temporaryDefault", "answer", "failure"]);
    if (Buffer.byteLength(JSON.stringify(source)) > MAX_QUESTION_BYTES + MAX_ANSWER_BYTES + 2048) fail();
    if (typeof source.displayId !== "string" || !/^Q-[1-9][0-9]*$/.test(source.displayId) || source.displayId.length > 32) fail();
    if (!["pending", "submitted", "delivery_failed"].includes(String(source.state))) fail();
    const response = object(source.response);
    keys(response, ["kind"], ["options"]);
    if (!["text", "single", "multiple", "single_or_text", "multiple_or_text"].includes(String(response.kind))) fail();
    const options = response.options === undefined ? [] : response.options;
    if (!Array.isArray(options) || options.length > 8 || (response.kind !== "text" && options.length < 2) || (response.kind === "text" && options.length !== 0)) fail();
    const parsedOptions = options.map((raw) => {
      const option = object(raw); keys(option, ["id", "label"], ["description"]);
      return { id: optionIds([option.id])[0]!, label: text(option.label, 640), ...(option.description === undefined ? {} : { description: text(option.description, 2000) }) };
    });
    optionIds(parsedOptions.map((option) => option.id));
    const question: ProjectGlanceQuestion = { id: id(source.id), displayId: source.displayId, revision: revision(source.revision), state: source.state as ProjectGlanceQuestion["state"], question: text(source.question, 640), reason: text(source.reason, MAX_QUESTION_BYTES), response: { kind: response.kind as ProjectGlanceQuestion["response"]["kind"], ...(response.options === undefined ? {} : { options: parsedOptions }) } };
    for (const key of ["recommendation", "recommendedText", "failure"] as const) if (source[key] !== undefined) question[key] = text(source[key], key === "failure" ? 2048 : MAX_QUESTION_BYTES);
    if (source.recommendedOptionIds !== undefined) question.recommendedOptionIds = optionIds(source.recommendedOptionIds);
    if (source.temporaryDefault !== undefined) {
      const temp = object(source.temporaryDefault); keys(temp, ["optionIds", "disclosure"]);
      question.temporaryDefault = { optionIds: optionIds(temp.optionIds), disclosure: text(temp.disclosure, 4000) };
    }
    if (source.answer !== undefined) question.answer = validateQuestionAnswer(source.answer);
    return question;
  });
  if (new Set(result.map((question) => question.id)).size !== result.length) fail();
  return result;
}
