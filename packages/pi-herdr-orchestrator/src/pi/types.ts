export interface PiModelLike {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
  [key: string]: unknown;
}
export interface PiToolLike {
  name: string;
  [key: string]: unknown;
}
export interface PiSessionManagerLike {
  getSessionId?(): string;
  getSessionFile?(): string | undefined;
  getCwd?(): string;
  getEntries?(): unknown[];
  [key: string]: unknown;
}
export interface PiModelRegistryLike {
  getAvailable?(): PiModelLike[];
  getAll?(): PiModelLike[];
  find?(provider: string, modelId: string): PiModelLike | undefined;
  [key: string]: unknown;
}
export interface PiUiLike {
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
  [key: string]: unknown;
}
export interface PiContextLike {
  ui: PiUiLike;
  cwd: string;
  sessionManager: PiSessionManagerLike;
  modelRegistry: PiModelRegistryLike;
  model?: PiModelLike;
  scopedModels?: readonly (
    PiModelLike | { model: PiModelLike; thinkingLevel?: string }
  )[];
  thinkingLevel?: string;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  compact(options?: {
    onComplete?: () => void;
    onError?: (error: Error) => void;
  }): void;
  getContextUsage?():
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  getScopedModels?(): PiModelLike[] | { models: PiModelLike[] };
  [key: string]: unknown;
}
