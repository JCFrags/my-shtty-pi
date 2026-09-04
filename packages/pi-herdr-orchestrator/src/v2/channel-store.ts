import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, stat, unlink, watch, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { domainDirectoryFor } from "./store.js";
import type { ChannelEvent, RunResult } from "./types.js";

const MAX_FILE_BYTES = 24 * 1024;
const MAX_EVENT_FILES = 1024;

export class ChannelStoreError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "ChannelStoreError"; this.code = code; }
}

async function readJson<T>(path: string): Promise<T> {
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) throw new ChannelStoreError("CHANNEL_RECORD_TOO_LARGE");
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof ChannelStoreError) throw error;
    throw new ChannelStoreError((error as { code?: string }).code === "ENOENT" ? "RESULT_NOT_READY" : "CHANNEL_RECORD_MALFORMED");
  }
}

export class ChannelStore {
  readonly directory: string;
  readonly eventsDirectory: string;
  readonly resultsDirectory: string;
  constructor(readonly domainId: string) {
    this.directory = domainDirectoryFor(domainId);
    this.eventsDirectory = join(this.directory, "events");
    this.resultsDirectory = join(this.directory, "results");
  }
  async ensure(): Promise<void> {
    await mkdir(this.eventsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.resultsDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([this.directory, this.eventsDirectory, this.resultsDirectory].map((p) => chmod(p, 0o700).catch(() => undefined)));
  }
  private async immutable(path: string, value: unknown): Promise<boolean> {
    await this.ensure();
    const temporary = join(this.directory, `.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    try { await link(temporary, path); return true; }
    catch (error) { if ((error as { code?: string }).code === "EEXIST") return false; throw error; }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  async appendEvent(event: ChannelEvent): Promise<void> {
    const files = await readdir(this.eventsDirectory).catch(() => [] as string[]);
    if (files.length >= MAX_EVENT_FILES) throw new ChannelStoreError("CHANNEL_EVENT_CAPACITY_REACHED");
    const path = join(this.eventsDirectory, `${event.eventId}.json`);
    if (!(await this.immutable(path, event))) throw new ChannelStoreError("CHANNEL_EVENT_CONFLICT");
  }
  resultPath(runId: string): string {
    if (!/^r-[0-9a-f-]{36}$/u.test(runId)) throw new ChannelStoreError("INVALID_RUN_ID");
    return join(this.resultsDirectory, `${runId}.json`);
  }
  async complete(requested: Omit<RunResult, "completedAt">): Promise<{ result: RunResult; duplicate: boolean }> {
    const result: RunResult = { ...requested, completedAt: new Date().toISOString() };
    const path = this.resultPath(result.runId);
    if (await this.immutable(path, result)) return { result, duplicate: false };
    const existing = await readJson<RunResult>(path);
    const same = existing.version === requested.version && existing.domainId === requested.domainId && existing.agentId === requested.agentId &&
      existing.runId === requested.runId && existing.agentGeneration === requested.agentGeneration &&
      existing.assignmentGeneration === requested.assignmentGeneration && existing.status === requested.status &&
      existing.summary === requested.summary && existing.finalResult === requested.finalResult;
    if (!same) throw new ChannelStoreError("COMPLETION_CONFLICT");
    return { result: existing, duplicate: true };
  }
  async result(runId: string): Promise<RunResult | undefined> {
    try { return await readJson<RunResult>(this.resultPath(runId)); }
    catch (error) { if (error instanceof ChannelStoreError && error.code === "RESULT_NOT_READY") return undefined; throw error; }
  }
  async events(): Promise<ChannelEvent[]> {
    await this.ensure();
    const names = (await readdir(this.eventsDirectory)).filter((n) => /^[0-9]{13}-[0-9a-f-]{36}\.json$/u.test(n)).sort();
    const events: ChannelEvent[] = [];
    for (const name of names) events.push(await readJson<ChannelEvent>(join(this.eventsDirectory, name)));
    return events;
  }
  async waitForChange(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return;
    await this.ensure();
    const controllers = [new AbortController(), new AbortController()];
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => { if (settled) return; settled = true; controllers.forEach((c) => c.abort()); clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      const consume = async (directory: string, signal: AbortSignal): Promise<void> => {
        try { for await (const _event of watch(directory, { signal })) { finish(); break; } } catch { finish(); }
      };
      void consume(this.eventsDirectory, controllers[0]!.signal);
      void consume(this.resultsDirectory, controllers[1]!.signal);
    });
  }
}
