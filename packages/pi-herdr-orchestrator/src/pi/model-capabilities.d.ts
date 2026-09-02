import type { ThinkingLevel } from "../broker/model-policy.js";
export interface PiModelCapability {
  readonly provider: string;
  readonly modelId: string;
  readonly reasoning: boolean;
  readonly thinkingLevels: readonly ThinkingLevel[];
}
export interface PiCapabilitySnapshot {
  readonly models: readonly PiModelCapability[];
  readonly thinkingLevels: readonly ThinkingLevel[];
}
