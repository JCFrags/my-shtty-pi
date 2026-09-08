import {
  Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  MAX_ANSWER_BYTES, MAX_PENDING_QUESTIONS,
  type ProjectGlanceQuestion, type ProjectGlanceQuestionAction,
} from "../questions/model.js";

type Control = "prev" | "next" | "text" | "submit" | "cancel" | "retry" | `option:${number}`;
type Target = { control: Control; row: number; start: number; end: number };

/** A bounded, display-only projection plus explicit user actions. No relay access.
 * Place between CURRENT and feed; an enclosing ScrollView may bound its viewport.
 * Route input here before feed when ownsKeyboard, and propagate TUI focus.
 * identityKey must include session AND branch identity (not snapshot revision).
 */
export class ProjectGlanceQuestionsRegion implements Component, Focusable {
  #questions: readonly ProjectGlanceQuestion[] = [];
  #identity = "";
  #index = 0;
  #key = "";
  #input = new Input({ placeholder: "Type an answer" });
  #selected = new Set<string>();
  #control: Control = "submit";
  #focused = false;
  #busy = false;
  #completed: "Submitted" | "Cancelled" | undefined;
  #error = "";
  #targets: Target[] = [];
  #width = 0;
  #height = 0;
  #generation = 0;

  constructor(
    private readonly onAction: (action: ProjectGlanceQuestionAction) => Promise<void> | void,
    private readonly requestRender: () => void,
  ) {}

  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.syncFocus(); }
  get ownsKeyboard(): boolean { return this.focused && this.#questions.length > 0; }
  get isEditing(): boolean { return this.ownsKeyboard && this.#control === "text" && this.editable; }
  private get question(): ProjectGlanceQuestion | undefined { return this.#questions[this.#index]; }
  private get editable(): boolean { return this.question?.state === "pending" && !this.#busy && !this.#completed; }
  private get hasText(): boolean { return this.question?.response.kind === "text" || !!this.question?.response.kind.endsWith("_or_text"); }

  update(questions: readonly ProjectGlanceQuestion[], identityKey: string): void {
    const oldId = this.question?.id;
    const oldState = this.question?.state;
    this.#questions = questions.slice(0, MAX_PENDING_QUESTIONS);
    this.#identity = identityKey;
    const found = this.#questions.findIndex((q) => q.id === oldId);
    this.#index = found < 0 ? 0 : found;
    this.resetIfChanged();
    if (oldState !== this.question?.state) {
      this.#generation++;
      this.#busy = false;
      this.#completed = undefined;
      this.#error = "";
      this.syncFocus();
    }
    this.invalidate();
  }

  private resetIfChanged(): void {
    const q = this.question;
    const key = JSON.stringify([this.#identity, q?.id, q?.revision]);
    if (key !== this.#key) {
      this.#key = key;
      this.#generation++;
      this.#selected.clear();
      // New Input also discards undo/kill history from the previous question.
      this.#input = new Input({ placeholder: "Type an answer" });
      this.#busy = false;
      this.#completed = undefined;
      this.#error = "";
      this.#control = q?.response.options?.length ? "option:0" : this.hasText ? "text" : "submit";
    }
    this.syncFocus();
  }

  private syncFocus(): void { this.#input.focused = this.isEditing; }
  invalidate(): void { this.#targets = []; this.#width = 0; this.#input.invalidate(); }
  private changed(): void { this.syncFocus(); this.invalidate(); this.requestRender(); }

  private controls(): Control[] {
    const controls: Control[] = this.#questions.length > 1 ? ["prev", "next"] : [];
    if (this.editable) {
      for (let i = 0; i < Math.min(this.question?.response.options?.length ?? 0, 8); i++) controls.push(`option:${i}`);
      if (this.hasText) controls.push("text");
      controls.push("submit", "cancel");
    } else if (!this.#busy && !this.#completed && this.question?.state === "delivery_failed") {
      controls.push("retry", "cancel");
    }
    return controls;
  }

  private move(delta: number): void {
    const controls = this.controls();
    if (controls.length) {
      const index = controls.indexOf(this.#control);
      this.#control = controls[(index + delta + controls.length) % controls.length]!;
    }
    this.changed();
  }

  /** True means consumed, including unknown keys while this region owns focus. */
  handleInput(data: string): boolean {
    if (!this.ownsKeyboard) return false;
    if (matchesKey(data, "tab")) this.move(1);
    else if (matchesKey(data, "shift+tab")) this.move(-1);
    else if (this.isEditing) {
      // Enter leaves editing; a second, explicit activation of Submit is required.
      if (matchesKey(data, "enter") || matchesKey(data, "escape")) this.#control = "submit";
      else this.#input.handleInput(data);
      this.#error = "";
      this.changed();
    } else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "enter") || matchesKey(data, "space")) this.activate(this.#control);
    // No implicit cancel, submit, recommendation selection, or feed shortcuts.
    return true;
  }

  private activate(control: Control): void {
    if (!this.controls().includes(control)) return;
    if (control === "prev" || control === "next") {
      this.#index = (this.#index + (control === "next" ? 1 : -1) + this.#questions.length) % this.#questions.length;
      this.resetIfChanged();
    } else if (control.startsWith("option:")) {
      const option = this.question?.response.options?.[Number(control.slice(7))];
      if (option) {
        if (this.#selected.has(option.id)) this.#selected.delete(option.id);
        else {
          if (!this.question?.response.kind.startsWith("multiple")) this.#selected.clear();
          this.#selected.add(option.id);
        }
        // *_or_text means an alternative, not a silently combined answer.
        this.#input.setValue("");
      }
    } else if (control === "submit" || control === "cancel" || control === "retry") {
      this.dispatch(control);
    }
    this.changed();
  }

  private dispatch(control: "submit" | "cancel" | "retry"): void {
    const q = this.question;
    if (!q || this.#busy) return;
    const base = { questionId: q.id, expectedRevision: q.revision };
    let action: ProjectGlanceQuestionAction;
    if (control === "submit") {
      const text = this.hasText ? this.#input.getValue().trim() : "";
      const optionIds = text ? [] : [...this.#selected];
      if (!text && !optionIds.length) { this.#error = "Choose an option or type an answer."; return; }
      const answer = { optionIds, ...(text ? { text } : {}) };
      if (Buffer.byteLength(JSON.stringify(answer), "utf8") > MAX_ANSWER_BYTES) {
        this.#error = "Answer is too long (maximum 4 KiB).";
        return;
      }
      action = { type: "question_answer", ...base, answer };
    } else action = { type: control === "cancel" ? "question_cancel" : "question_retry", ...base };
    this.#busy = true;
    this.#error = "";
    const generation = this.#generation;
    // Capture synchronous throws as well as rejected promises; never render raw errors.
    const send = async () => { await this.onAction(action); };
    void send().then(() => {
      if (this.#generation !== generation) return;
      this.#completed = control === "cancel" ? "Cancelled" : "Submitted";
    }, () => {
      if (this.#generation !== generation) return;
      this.#error = "Action failed. Try again.";
    }).finally(() => {
      if (this.#generation !== generation) return;
      this.#busy = false;
      this.changed();
    });
  }

  render(width: number): string[] {
    this.#targets = [];
    this.#width = Math.max(0, Math.floor(width));
    const q = this.question;
    if (!q || this.#width === 0) { this.#height = 0; return []; }
    const w = this.#width;
    const lines: string[] = [];
    const line = (text: string) => lines.push(truncateToWidth(text, w));
    const paragraph = (text: string, max: number) => {
      const wrapped = wrapTextWithAnsi(text, Math.max(1, w));
      for (const part of wrapped.slice(0, max)) line(part);
      if (wrapped.length > max && lines.length) lines[lines.length - 1] = truncateToWidth(`${lines.at(-1)} …`, w);
    };
    const button = (label: string, control: Control) => {
      const rendered = truncateToWidth(`${this.focused && this.#control === control ? ">" : " "}[${label}]`, w);
      this.#targets.push({ control, row: lines.length, start: 0, end: visibleWidth(rendered) });
      lines.push(rendered);
    };
    line(`QUESTIONS ${this.#index + 1}/${this.#questions.length} · ${q.displayId}`);
    if (this.#questions.length > 1) {
      // Separate short rows keep both actions reachable at very narrow widths.
      button("Prev", "prev"); button("Next", "next");
    }
    paragraph(q.question, 2);
    if (q.reason) paragraph(q.reason, 1);
    if (q.recommendation) paragraph(`Recommended: ${q.recommendation}`, 1);
    if (q.recommendedOptionIds?.length) line(`Suggested options: ${q.recommendedOptionIds.join(", ")}`);
    if (q.recommendedText) line(`Suggested text: ${q.recommendedText}`);
    if (q.temporaryDefault) paragraph(`Temporary default: ${q.temporaryDefault.disclosure}`, 1);
    line(this.#busy ? "Sending…" : this.#completed ?? q.state);
    if (q.state === "delivery_failed") paragraph(q.failure || "Answer delivery failed.", 1);
    if (q.state === "submitted" || q.state === "delivery_failed") {
      if (q.answer?.optionIds.length) line(`Answer: ${q.answer.optionIds.join(", ")}`);
      if (q.answer?.text) paragraph(`Answer: ${q.answer.text}`, 1);
    }
    if (this.editable) {
      (q.response.options ?? []).slice(0, 8).forEach((option, i) => {
        const chosen = this.#selected.has(option.id) && !this.#input.getValue().trim();
        button(`${chosen ? "x" : " "} ${option.label}${option.description ? ` — ${option.description}` : ""}`, `option:${i}`);
      });
      if (this.hasText) {
        line(q.response.kind === "text" ? "Answer:" : "Or type an answer:");
        this.syncFocus();
        this.#targets.push({ control: "text", row: lines.length, start: 0, end: w });
        // Input horizontally scrolls and owns cursor, paste, undo, and editing keys.
        lines.push(...this.#input.render(w).map((text) => truncateToWidth(text, w)));
      }
      button("Submit", "submit"); button("Cancel", "cancel");
    } else if (!this.#busy && !this.#completed && q.state === "delivery_failed") {
      button("Retry", "retry"); button("Cancel", "cancel");
    }
    if (this.#error) line(this.#error);
    line("Tab/↑↓ move · Enter activate");
    this.#height = lines.length;
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.#width !== event.width) this.render(event.width);
    if (event.y < 0 || event.y >= this.#height || event.x < 0 || event.x >= event.width) return undefined;
    // Let the surrounding question ScrollView own wheels, not the feed.
    if (event.type === "wheel") return undefined;
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    const target = this.#targets.find((t) => t.row === event.y && event.x >= t.start && event.x < t.end);
    this.focused = true;
    if (target) {
      this.#control = target.control;
      this.syncFocus();
      if (target.control === "text") {
        this.#input.handleMouse({ ...event, type: "press", y: 0, height: 1 });
      } else if (event.type === "click") this.activate(target.control);
    }
    this.changed();
    return { handled: true, focus: true, render: true };
  }
}
