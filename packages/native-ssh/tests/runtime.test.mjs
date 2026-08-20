import test from "node:test";
import assert from "node:assert/strict";
import { RemoteRuntime } from "../src/runtime.mjs";

function runtimeFor(result, imageProcessor = null) {
  const ended = [];
  const controller = {
    begin(operation, _signal, ctx) { return { operation, target: { name: "fixture", destination: "fixture", cwd: "/" }, controller: new AbortController(), ctx }; },
    end(lease, error) { ended.push({ lease, error }); },
  };
  const transport = { request: async () => ({ result, meta: { durationMs: 1, stdoutBytes: 10, stderrBytes: 0 } }) };
  const audit = { record() {} };
  const runtime = new RemoteRuntime(controller, transport, audit, imageProcessor);
  runtime.capabilities.set("fixture", {});
  return { runtime, ended };
}

test("remote image read preserves native Pi content and details shape", async () => {
  const image = Buffer.from("image-bytes").toString("base64");
  const processed = { content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: image, mimeType: "image/png" }], details: undefined };
  const processor = async (source, args) => { assert.equal(source.data, image); assert.equal(args.path, "pixel.png"); return processed; };
  const { runtime, ended } = runtimeFor({ kind: "image", mimeType: "image/png", data: image }, processor);
  const result = await runtime.execute("read", { path: "pixel.png", offset: 1, limit: null }, undefined, { model: { input: ["text", "image"] } });
  assert.deepEqual(result, processed);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].error, null);
});

test("remote text read uses only native read detail keys", async () => {
  const truncation = { truncated: false, truncatedBy: null, totalLines: 1, totalBytes: 4, outputLines: 1, outputBytes: 4, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 2000, maxBytes: 51200 };
  const { runtime } = runtimeFor({ kind: "text", data: "text", truncation, totalFileLines: 1, startLine: 1, userLimitedLines: null, hasMoreAfterUserLimit: false });
  const result = await runtime.execute("read", { path: "text", offset: 1, limit: null }, undefined, { model: { input: ["text"] } });
  assert.deepEqual(result, { content: [{ type: "text", text: "text" }], details: undefined });
});
