import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piBuiltinSemantics } from "./pi-semantics.js";
import type { BuiltinSemantics, ReviewToolKind } from "./preview.js";

export const ADAPTER_PROTOCOL_VERSION = 1 as const;
export const REGISTER_ADAPTER_EVENT = "pi-review-ui:register-preview-adapter-v1";
export const REQUEST_ADAPTERS_EVENT = "pi-review-ui:request-preview-adapters-v1";

export interface PreviewAdapterRegistration {
  protocolVersion: typeof ADAPTER_PROTOCOL_VERSION;
  id: string;
  ownerSourcePath: string;
  tools: readonly ReviewToolKind[];
  semantics: BuiltinSemantics;
}

interface ToolSourceInfo {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

interface ToolInfo {
  name: string;
  sourceInfo: ToolSourceInfo;
}

export class PreviewAdapterRegistry {
  private readonly adapters = new Map<string, PreviewAdapterRegistration>();

  register(value: unknown): void {
    if (!isRegistration(value)) return;
    const key = resolve(value.ownerSourcePath);
    const existing = this.adapters.get(key);
    if (existing && existing.id !== value.id) {
      this.adapters.delete(key);
      return;
    }
    this.adapters.set(key, value);
  }

  resolve(tool: ReviewToolKind, allTools: readonly ToolInfo[]): BuiltinSemantics {
    const matches = allTools.filter((candidate) => candidate.name === tool);
    if (matches.length !== 1) {
      throw new Error(`unsupported ${tool} owner: expected one active tool definition, found ${matches.length}`);
    }

    const owner = matches[0]!.sourceInfo;
    if (owner.source === "builtin") {
      if (owner.path !== `<builtin:${tool}>`) {
        throw new Error(`unsupported ${tool} builtin provenance: ${owner.path}`);
      }
      return piBuiltinSemantics;
    }

    const adapter = this.adapters.get(resolve(owner.path));
    if (!adapter || !adapter.tools.includes(tool)) {
      throw new Error(`unsupported ${tool} owner: ${owner.source} (${owner.path})`);
    }
    return adapter.semantics;
  }
}

export function connectPreviewAdapters(pi: ExtensionAPI, registry: PreviewAdapterRegistry): void {
  pi.events.on(REGISTER_ADAPTER_EVENT, (value) => registry.register(value));
  pi.events.emit(REQUEST_ADAPTERS_EVENT, (value: unknown) => registry.register(value));
}

function isRegistration(value: unknown): value is PreviewAdapterRegistration {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PreviewAdapterRegistration>;
  return candidate.protocolVersion === ADAPTER_PROTOCOL_VERSION
    && typeof candidate.id === "string"
    && candidate.id.length > 0
    && typeof candidate.ownerSourcePath === "string"
    && candidate.ownerSourcePath.length > 0
    && Array.isArray(candidate.tools)
    && candidate.tools.length > 0
    && candidate.tools.every((tool) => tool === "edit" || tool === "write")
    && isSemantics(candidate.semantics);
}

function isSemantics(value: unknown): value is BuiltinSemantics {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BuiltinSemantics>;
  return typeof candidate.constructEdit === "function"
    && typeof candidate.constructWrite === "function"
    && typeof candidate.generateUnifiedDiff === "function";
}
