import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerAskUserFacadeV1, loadAskUserV1Enabled } from "./ask-user-facade.ts";
import { registerBlockingProviderV1 } from "./blocking-provider.ts";

interface QuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

interface Question {
  id: string;
  prompt: string;
  options: QuestionOption[];
}

interface Answer {
  id: string;
  value: string;
  label: string;
  custom: boolean;
}

const OptionSchema = Type.Object({
  value: Type.String({ description: "Stable value returned to the model" }),
  label: Type.String({ description: "Short option label" }),
  description: Type.Optional(Type.String({ description: "Meaning, tradeoff, or consequence" })),
  preview: Type.Optional(Type.String({ description: "Markdown, code, diagram, config, or mockup to compare" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique question id" }),
  prompt: Type.String({ description: "The decision or missing information" }),
  options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4 }),
});

const AskParams = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
});

class QuestionComponent implements Focusable {
  private selected = 0;
  private editing = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly editor: Editor;
  private _focused = false;

  constructor(
    private readonly question: Question,
    private readonly theme: Theme,
    tui: ConstructorParameters<typeof Editor>[0],
    private readonly done: (result: { option?: QuestionOption; custom?: string } | null) => void,
  ) {
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme);
    this.editor.onSubmit = (value) => {
      const text = value.trim();
      if (text) this.done({ custom: text });
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    if (this.editing) {
      if (matchesKey(data, Key.escape)) {
        this.editing = false;
        this.editor.setText("");
        this.invalidate();
        return;
      }
      this.editor.handleInput(data);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(this.question.options.length, this.selected + 1);
    else if (matchesKey(data, Key.enter)) {
      if (this.selected === this.question.options.length) {
        this.editing = true;
        this.editor.setText("");
      } else {
        const option = this.question.options[this.selected];
        if (option) this.done({ option });
      }
    } else if (matchesKey(data, Key.escape)) this.done(null);
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
    const usable = Math.max(20, width);
    const lines: string[] = [this.theme.fg("accent", "─".repeat(usable))];
    lines.push(...wrapTextWithAnsi(` ${this.question.prompt}`, usable));
    lines.push("");

    const options = [...this.question.options, { value: "__custom__", label: "Type something", description: "Give a free-form answer" }];
    for (let index = 0; index < options.length; index++) {
      const option = options[index]!;
      const selected = index === this.selected;
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      lines.push(...wrapTextWithAnsi(`${prefix}${index + 1}. ${selected ? this.theme.fg("accent", option.label) : option.label}`, usable));
      if (option.description) lines.push(...wrapTextWithAnsi(`     ${this.theme.fg("muted", option.description)}`, usable));
    }

    const selectedOption = this.question.options[this.selected];
    if (selectedOption?.preview) {
      lines.push("");
      lines.push(this.theme.fg("muted", " Preview"));
      lines.push(...selectedOption.preview.split("\n").flatMap((line) => wrapTextWithAnsi(` │ ${line}`, usable)));
    }

    if (this.editing) {
      lines.push("");
      lines.push(this.theme.fg("muted", " Your answer:"));
      const rendered = this.editor.render(Math.max(10, usable - 2));
      for (const line of rendered) lines.push(` ${line}`);
    }
    lines.push("");
    lines.push(this.theme.fg("dim", this.editing ? " Enter submit • Esc options" : " ↑↓ select • Enter confirm • Esc cancel"));
    lines.push(this.theme.fg("accent", "─".repeat(usable)));
    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, usable));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
  }
}

async function askTui(
  question: Question,
  ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
): Promise<{ option?: QuestionOption; custom?: string } | null> {
  return ctx.ui.custom<{ option?: QuestionOption; custom?: string } | null>((tui, theme, _keybindings, done) => {
    const component = new QuestionComponent(question, theme, tui, done);
    return {
      get focused() { return component.focused; },
      set focused(value: boolean) { component.focused = value; },
      render: (width) => component.render(width),
      handleInput: (data) => {
        component.handleInput(data);
        tui.requestRender();
      },
      invalidate: () => component.invalidate(),
    } as Focusable & { render(width: number): string[]; handleInput(data: string): void; invalidate(): void };
  });
}

async function askRpc(question: Question, ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4]) {
  const choices = [
    ...question.options.map((option, index) => {
      const description = option.description ? ` — ${option.description}` : "";
      const preview = option.preview ? `\nPreview:\n${option.preview}` : "";
      return `${index + 1}. ${option.label}${description}${preview}`;
    }),
    "Type something",
  ];
  const selected = await ctx.ui.select(question.prompt, choices);
  if (!selected) return null;
  if (selected === "Type something") {
    const custom = await ctx.ui.input(question.prompt, "Your answer");
    return custom?.trim() ? { custom: custom.trim() } : null;
  }
  const index = choices.indexOf(selected);
  if (index < 0 || !question.options[index]) throw new Error("UI returned an unknown questionnaire option");
  return { option: question.options[index] };
}

export interface GroundedDialogRegistrationOptions {
  readonly askUserV1Enabled?: boolean;
}

export function registerGroundedDialog(
  pi: ExtensionAPI,
  options: GroundedDialogRegistrationOptions = {},
): void {
  registerBlockingProviderV1(pi);
  if (options.askUserV1Enabled === true) registerAskUserFacadeV1(pi);

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "ask_user_question"));
  });

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user",
    description: "Ask one to four structured questions instead of guessing. Each question has 2-4 explained options with optional previews, and the user can always give a free-form answer.",
    promptSnippet: "Ask structured questions when a consequential requirement or preference is genuinely unclear",
    promptGuidelines: [
      "Use ask_user_question only when the answer materially changes the implementation and cannot be learned from available evidence.",
      "Do not use ask_user_question for routine confirmations or questions whose answer is already present in the conversation or repository.",
    ],
    parameters: AskParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("ask_user_question is unavailable in non-interactive mode");
      const questionIds = new Set<string>();
      for (const question of params.questions) {
        if (!question.id.trim() || questionIds.has(question.id)) throw new Error(`Question ids must be non-empty and unique: ${question.id}`);
        if (!question.prompt.trim()) throw new Error(`Question ${question.id} has an empty prompt`);
        questionIds.add(question.id);
        const values = new Set<string>();
        for (const option of question.options) {
          if (!option.value.trim() || values.has(option.value)) throw new Error(`Question ${question.id} option values must be non-empty and unique`);
          if (!option.label.trim()) throw new Error(`Question ${question.id} has an empty option label`);
          values.add(option.value);
        }
      }
      const answers: Answer[] = [];
      for (const question of params.questions) {
        const result = ctx.mode === "tui" ? await askTui(question, ctx) : await askRpc(question, ctx);
        if (!result) {
          return {
            content: [{ type: "text", text: "User cancelled the questionnaire" }],
            details: { questions: params.questions, answers, cancelled: true },
          };
        }
        if (result.option) {
          answers.push({ id: question.id, value: result.option.value, label: result.option.label, custom: false });
        } else {
          answers.push({ id: question.id, value: result.custom!, label: result.custom!, custom: true });
        }
      }
      return {
        content: [{
          type: "text",
          text: answers.map((answer) => `${answer.id}: ${answer.custom ? "user wrote" : "user selected"}: ${answer.label}`).join("\n"),
        }],
        details: { questions: params.questions, answers, cancelled: false },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", `${args.questions.length} question(s)`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { answers?: Answer[]; cancelled?: boolean } | undefined;
      if (details?.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      return new Text(
        (details?.answers ?? []).map((answer) => `${theme.fg("success", "✓")} ${theme.fg("accent", answer.id)}: ${answer.label}`).join("\n"),
        0,
        0,
      );
    },
  });
}

export default function groundedDialog(pi: ExtensionAPI): void {
  registerGroundedDialog(pi, { askUserV1Enabled: loadAskUserV1Enabled() });
}
