import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, renameSync, symlinkSync, linkSync, openSync, closeSync, writeSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CatalogSource, CATALOG_SOURCE_ANCHOR_BYTES, CATALOG_SOURCE_CHUNK_BYTES } from "../src/catalog-source.js";
function fixture(run: (path: string, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "chrono-catalog-source-"));
  const path = join(directory, "source.jsonl");
  try { writeFileSync(path, Buffer.alloc(256 * 1024, 65), { mode: 0o600 }); run(path, directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
test("catalog source append/no-op reads have fixed verification overhead", () => fixture(path => {
  const first = new CatalogSource(path);
  const checkpoint = first.snapshot();
  assert.equal(first.bytesRead, 2 * CATALOG_SOURCE_ANCHOR_BYTES); first.close();
  appendFileSync(path, "delta");
  const next = new CatalogSource(path);
  try {
    next.verify(checkpoint);
    const delta = next.read(checkpoint.size, 5);
    assert.equal(delta.toString(), "delta");
    next.accept(checkpoint.size, delta);
    assert.equal(next.bytesRead, 2 * CATALOG_SOURCE_ANCHOR_BYTES + 5);
    const current = next.snapshot();
    assert.equal(current.size, checkpoint.size + 5);
  } finally { next.close(); }
}));
test("catalog source selected hashes catch unsampled mutation honestly", () => fixture(path => {
  const source = new CatalogSource(path);
  const snapshot = source.snapshot();
  const offset = 100 * 1024;
  const bytes = source.read(offset, 1024);
  const anchor = { offset, length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const fd = openSync(path, "r+");
  try { writeSync(fd, Buffer.from("B"), 0, 1, offset); } finally { closeSync(fd); }
  try {
    source.verify(snapshot); // Deliberately documents the bounded-anchor limitation.
    assert.throws(() => source.verifyRange(anchor), /catalog-source-changed/);
  } finally { source.close(); }
}));
test("catalog source rejects replacement and truncation without following new owner", () => fixture((path, directory) => {
  const source = new CatalogSource(path);
  try {
    renameSync(path, join(directory, "old"));
    writeFileSync(path, "new", { mode: 0o600 });
    assert.throws(() => source.assertCurrent(), /catalog-source-changed/);
    assert.equal(source.read(0, 1).toString(), "A");
  } finally { source.close(); }
  const replacement = new CatalogSource(path);
  try { truncateSync(path, 0); assert.throws(() => replacement.assertCurrent(), /catalog-source-changed/); }
  finally { replacement.close(); }
}));
test("catalog source rejects symlinks, hardlinks and unsafe ranges", () => fixture((path, directory) => {
  const alias = join(directory, "alias");
  symlinkSync(path, alias);
  assert.throws(() => new CatalogSource(alias), /catalog-source-unsafe/);
  rmSync(alias); linkSync(path, alias);
  assert.throws(() => new CatalogSource(path), /catalog-source-unsafe/);
  rmSync(alias);
  const source = new CatalogSource(path, 8);
  try {
    assert.throws(() => source.read(0, 9), /catalog-source-budget/);
    assert.equal(source.bytesRead, 0);
    assert.throws(() => source.read(0, CATALOG_SOURCE_CHUNK_BYTES + 1), /catalog-source-range/);
    assert.throws(() => source.read(-1, 1), /catalog-source-range/);
    assert.throws(() => source.read(Number.MAX_SAFE_INTEGER, 1), /catalog-source-range/);
    assert.equal(source.read(0, 8).length, 8);
    assert.throws(() => source.read(8, 1), /catalog-source-budget/);
  } finally { source.close(); source.close(); }
}));
test("catalog source snapshots validate canonical anchor shape including empty files", () => fixture(path => {
  truncateSync(path, 0);
  const source = new CatalogSource(path);
  try {
    const snapshot = source.snapshot(); source.verify(snapshot);
    assert.equal(source.bytesRead, 0);
    assert.throws(() => source.verify({ ...snapshot, anchors: [] }), /catalog-source-range/);
  } finally { source.close(); }
}));
function mutate(path: string, offset: number): void {
  const fd = openSync(path, "r+");
  try { writeSync(fd, Buffer.from("B"), 0, 1, offset); } finally { closeSync(fd); }
}
test("handoff refuses a previously verified anchor changed before publication", () => fixture(path => {
  const first = new CatalogSource(path), saved = first.snapshot(); first.close();
  appendFileSync(path, "delta");
  const source = new CatalogSource(path);
  try {
    source.verify(saved);
    source.accept(saved.size, source.read(saved.size, 5));
    mutate(path, 100);
    source.assertCurrent(); // Identity and size alone cannot protect the handoff.
    assert.throws(() => source.snapshot(saved.size + 5), /catalog-source-changed/);
  } finally { source.close(); }
}));
test("handoff does not adopt changed new bytes or an unconsumed read suffix", () => fixture(path => {
  const first = new CatalogSource(path), saved = first.snapshot(); first.close();
  appendFileSync(path, "delta");
  const source = new CatalogSource(path);
  try {
    source.verify(saved);
    const bytes = source.read(saved.size, 5);
    source.accept(saved.size, bytes.subarray(0, 3));
    assert.throws(() => source.snapshot(saved.size + 5), /catalog-source-range/);
    mutate(path, saved.size + 1);
    assert.throws(() => source.snapshot(saved.size + 3), /catalog-source-changed/);
  } finally { source.close(); }
}));
test("handoff carries small overlapping windows and keeps a fixed 96 KiB verification bound", () => fixture(path => {
  writeFileSync(path, Buffer.alloc(8000, 65));
  const first = new CatalogSource(path), saved = first.snapshot(); first.close();
  appendFileSync(path, Buffer.alloc(7 * 1024 * 1024, 65));
  const source = new CatalogSource(path);
  try {
    source.verify(saved);
    for (let offset = saved.size; offset < source.size; offset += CATALOG_SOURCE_CHUNK_BYTES) {
      const bytes = source.read(offset, Math.min(CATALOG_SOURCE_CHUNK_BYTES, source.size - offset));
      source.accept(offset, bytes);
    }
    const current = source.snapshot();
    assert.equal(current.size, source.size);
    assert.ok(source.bytesRead <= 7 * 1024 * 1024 + 6 * CATALOG_SOURCE_ANCHOR_BYTES);
    const check = new CatalogSource(path);
    try { check.verify(current); } finally { check.close(); }
  } finally { source.close(); }
}));
test("handoff allows concurrent pure append and charges at most 7 MiB plus 96 KiB", () => fixture(path => {
  const first = new CatalogSource(path), saved = first.snapshot(); first.close();
  appendFileSync(path, Buffer.alloc(7 * 1024 * 1024, 65));
  const source = new CatalogSource(path);
  try {
    source.verify(saved);
    for (let offset = saved.size; offset < source.size; offset += CATALOG_SOURCE_CHUNK_BYTES) {
      const bytes = source.read(offset, Math.min(CATALOG_SOURCE_CHUNK_BYTES, source.size - offset));
      source.accept(offset, bytes);
    }
    appendFileSync(path, "concurrent append"); // Outside this job's pinned size.
    const current = source.snapshot();
    assert.equal(current.size, source.size);
    assert.equal(source.bytesRead, 7 * 1024 * 1024 + 6 * CATALOG_SOURCE_ANCHOR_BYTES);
    const check = new CatalogSource(path);
    try {
      check.verify(current);
      const delta = check.read(current.size, check.size - current.size);
      assert.equal(delta.toString(), "concurrent append");
      check.accept(current.size, delta); check.snapshot();
    } finally { check.close(); }
  } finally { source.close(); }
}));
