import {
  createEditToolDefinition,
  generateUnifiedPatch,
  type EditOperations,
  type EditToolInput,
} from "@earendil-works/pi-coding-agent";
import type { BuiltinSemantics } from "./preview.js";

export type EditToolFactory = typeof createEditToolDefinition;

export async function constructEditWithBuiltin(
  request: {
    cwd: string;
    input: EditToolInput;
    current: Buffer;
    currentExists: boolean;
    signal?: AbortSignal;
  },
  factory: EditToolFactory = createEditToolDefinition,
): Promise<string> {
  let capturedContent: string | undefined;
  const operations: EditOperations = {
    async access(): Promise<void> {
      if (!request.currentExists) {
        throw Object.assign(new Error("file does not exist"), { code: "ENOENT" });
      }
    },
    async readFile(): Promise<Buffer> {
      return Buffer.from(request.current);
    },
    async writeFile(_absolutePath: string, content: string): Promise<void> {
      capturedContent = content;
    },
  };

  const definition = factory(request.cwd, { operations });
  await definition.execute(
    `pi-review-ui-preview-${Date.now()}`,
    request.input,
    request.signal,
    undefined,
    undefined,
  );

  if (capturedContent === undefined) {
    throw new Error("Pi edit preview completed without producing content");
  }
  return capturedContent;
}

export const piBuiltinSemantics: BuiltinSemantics = {
  constructEdit: constructEditWithBuiltin,
  generateUnifiedDiff(path, oldContent, newContent): string {
    return generateUnifiedPatch(path, oldContent, newContent);
  },
};
