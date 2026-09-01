import type { OmissionNotice } from "../types.js";
import { compactWhitespace, estimateTokensFromText, truncateToTokens, unique } from "../utils.js";
import type { ReducerContext, ReducerResult } from "./types.js";

const HIGH_VALUE = /\b(?:considered|hypothesis|suspect|because|therefore|concluded|conclusion|decided|chose|selected|plan|next|verify|test|inspect|read|run|uncertain|unresolved|risk|constraint|must|must not|cannot|failed|error|passed|fixed|result)\b/i;
const LOW_VALUE = /^(?:sure|okay|got it|i'll take a look|let me check|i will now|thanks|understood)[.!]?$/i;

function sentenceSplit(text: string): string[] {
  const normalized = compactWhitespace(text);
  const pieces = normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`*#-])|\n(?=\s*(?:[-*]|\d+\.|#{1,6}\s))/)
    .map((value) => value.trim())
    .filter(Boolean);
  return pieces.length > 0 ? pieces : [normalized];
}

function scoreSentence(sentence: string, index: number, total: number): number {
  let score = 0;
  if (index === 0) score += 4;
  if (index === total - 1) score += 4;
  if (HIGH_VALUE.test(sentence)) score += 8;
  if (/`[^`]+`|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|json|yaml|yml|toml|md)\b/.test(sentence)) score += 4;
  if (/\b\d+(?:\.\d+)?\b/.test(sentence)) score += 2;
  if (/^\s*(?:[-*]|\d+\.)/.test(sentence)) score += 2;
  if (LOW_VALUE.test(sentence)) score -= 10;
  return score;
}

export function reduceAssistantProse(context: ReducerContext): ReducerResult {
  const source = compactWhitespace(context.block.exactText);
  if (estimateTokensFromText(source) <= context.maxTokens) {
    return {
      text: source,
      reducer: "assistant-cleanup",
      version: "1.0.0",
      lossy: source !== context.block.exactText,
      omissions: source === context.block.exactText ? [] : [{ description: "Canonical whitespace normalization applied" }],
      metadata: { extractive: true },
    };
  }

  const sentences = sentenceSplit(source);
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, score: scoreSentence(sentence, index, sentences.length) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: typeof ranked = [];
  let used = 0;
  for (const item of ranked) {
    const tokens = estimateTokensFromText(item.sentence);
    if (selected.length > 0 && used + tokens > context.maxTokens) continue;
    selected.push(item);
    used += tokens;
    if (used >= context.maxTokens * 0.9) break;
  }
  selected.sort((a, b) => a.index - b.index);
  let text = unique(selected.map((item) => item.sentence)).join(" ");
  text = truncateToTokens(text, context.maxTokens, " …[additional prose omitted]… ");
  const omitted = Math.max(0, sentences.length - selected.length);
  const omissions: OmissionNotice[] = [
    {
      description: `${omitted} lower-value or repeated prose segment(s) omitted; hypotheses, decisions, evidence, next action, and uncertainty prioritized`,
    },
  ];
  return {
    text,
    reducer: "assistant-extractive",
    version: "1.0.0",
    lossy: true,
    omissions,
    metadata: { extractive: true, originalSegments: sentences.length, selectedSegments: selected.length },
  };
}
