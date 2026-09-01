import type { HistoricalBlock, OmissionNotice } from "../types.js";

export interface ReducerContext {
  readonly block: HistoricalBlock;
  readonly maxTokens: number;
  readonly laterText: string;
}

export interface ReducerResult {
  readonly text: string;
  readonly reducer: string;
  readonly version: string;
  readonly lossy: boolean;
  readonly omissions: readonly OmissionNotice[];
  readonly metadata: Readonly<Record<string, unknown>>;
}
