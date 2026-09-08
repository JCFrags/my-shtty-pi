import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  watch,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { domainDirectoryFor } from "./store.js";
import type { ChannelEvent, RunResult } from "./types.js";
const MAX_FILE_BYTES = 24 * 1024,
  MAX_PENDING_PER_RUN = 256,
  ALLOCATOR_ATTEMPTS = 40,
  ALLOCATOR_RETRY_MS = 25,
  STALE_LOCK_MS = 30_000;
export class ChannelStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ChannelStoreError";
    this.code = code;
  }
}
async function readJson<T>(path: string): Promise<T> {
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES)
      throw new ChannelStoreError("CHANNEL_RECORD_TOO_LARGE");
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if (e instanceof ChannelStoreError) throw e;
    throw new ChannelStoreError(
      (e as { code?: string }).code === "ENOENT"
        ? "RESULT_NOT_READY"
        : "CHANNEL_RECORD_MALFORMED",
    );
  }
}
function validRunId(id: string): boolean {
  return /^r-[0-9a-f-]{36}$/u.test(id);
}
type AllocatorLock = { path: string; token: string };
type LockOwner = {
  pid: number;
  processStart: string | null;
  token: string;
  createdAt: number;
};
async function processStart(pid: number): Promise<string | null> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return value.slice(value.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
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
  async ensure() {
    await mkdir(this.eventsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.resultsDirectory, { recursive: true, mode: 0o700 });
    await Promise.all(
      [this.directory, this.eventsDirectory, this.resultsDirectory].map((p) =>
        chmod(p, 0o700).catch(() => undefined),
      ),
    );
  }
  private async runDirectory(runId: string) {
    if (!validRunId(runId)) throw new ChannelStoreError("INVALID_RUN_ID");
    await this.ensure();
    const d = join(this.eventsDirectory, runId);
    await mkdir(d, { recursive: true, mode: 0o700 });
    await chmod(d, 0o700).catch(() => undefined);
    return d;
  }
  private async atomicReplace(path: string, value: unknown): Promise<void> {
    await this.ensure();
    const tmp = join(this.directory, `.${process.pid}.${randomUUID()}.tmp`);
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(tmp, path);
      const directory = await open(join(path, ".."));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
  private async immutable(path: string, value: unknown): Promise<boolean> {
    await this.ensure();
    const tmp = join(this.directory, `.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    try {
      await link(tmp, path);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") return false;
      throw e;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
  private async acquireAllocator(runDirectory: string): Promise<AllocatorLock> {
    const lockPath = join(runDirectory, ".sequence.lock");
    for (let attempt = 0; attempt < ALLOCATOR_ATTEMPTS; attempt++) {
      const token = randomUUID();
      try {
        await mkdir(lockPath, { mode: 0o700 });
        const owner: LockOwner = {
          pid: process.pid,
          processStart: await processStart(process.pid),
          token,
          createdAt: Date.now(),
        };
        await writeFile(join(lockPath, `${token}.json`), `${JSON.stringify(owner)}\n`, {
          mode: 0o600,
        });
        return { path: lockPath, token };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT") {
          await mkdir(runDirectory, { recursive: true, mode: 0o700 });
          continue;
        }
        if (code !== "EEXIST") {
          await rm(lockPath, { recursive: true, force: true }).catch(
            () => undefined,
          );
          throw error;
        }
        let stale = false;
        try {
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          if (age > STALE_LOCK_MS) {
            const ownerName = (await readdir(lockPath)).find((name) =>
              /^[0-9a-f-]{36}\.json$/u.test(name),
            );
            if (!ownerName) throw new Error("allocator owner missing");
            const owner = JSON.parse(
              await readFile(join(lockPath, ownerName), "utf8"),
            ) as Partial<LockOwner>;
            if (Number.isSafeInteger(owner.pid)) {
              const currentStart = await processStart(Number(owner.pid));
              stale =
                currentStart === null ||
                (typeof owner.processStart === "string" &&
                  owner.processStart !== currentStart);
            } else stale = true;
          }
        } catch (inspectError) {
          if ((inspectError as { code?: string }).code === "ENOENT") continue;
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          stale = age > STALE_LOCK_MS;
        }
        if (stale) {
          const tombstone = join(
            runDirectory,
            `.sequence.stale.${process.pid}.${randomUUID()}`,
          );
          try {
            await rename(lockPath, tombstone);
            await rm(tombstone, { recursive: true, force: true });
            continue;
          } catch (reclaimError) {
            if ((reclaimError as { code?: string }).code === "ENOENT") continue;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, ALLOCATOR_RETRY_MS));
      }
    }
    throw new ChannelStoreError("CHANNEL_ALLOCATOR_BUSY");
  }
  private async releaseAllocator(lock: AllocatorLock): Promise<void> {
    try {
      await unlink(join(lock.path, `${lock.token}.json`));
      // Non-recursive removal is essential: if stale reclamation installed a
      // successor, its different token file makes this fail rather than delete it.
      await rmdir(lock.path);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
        String((error as { code?: string }).code),
      ))
        throw error;
    }
  }
  async appendEvent(
    base: Omit<ChannelEvent, "sequence">,
    deliveredSequence: number,
  ): Promise<ChannelEvent> {
    const d = await this.runDirectory(base.runId);
    const lock = await this.acquireAllocator(d);
    try {
      await this.migrateLegacyLocked(base.runId, d, deliveredSequence);
      const names = (await readdir(d))
        .filter((n) => /^\d{12}\.json$/u.test(n))
        .sort();
      if (names.length >= MAX_PENDING_PER_RUN)
        throw new ChannelStoreError("RUN_EVENT_CAPACITY_REACHED");
      let highWater = 0;
      try {
        const stored = await readJson<{ sequence: number }>(
          join(d, ".sequence.json"),
        );
        if (Number.isSafeInteger(stored.sequence) && stored.sequence >= 0)
          highWater = stored.sequence;
        else throw new ChannelStoreError("CHANNEL_RECORD_MALFORMED");
      } catch (error) {
        if (!(error instanceof ChannelStoreError) || error.code !== "RESULT_NOT_READY")
          throw error;
      }
      const visibleMaximum = names.length
        ? Number(names.at(-1)!.slice(0, 12))
        : 0;
      const sequence = Math.max(
        highWater,
        deliveredSequence,
        visibleMaximum,
      ) + 1;
      if (!Number.isSafeInteger(sequence) || sequence > 999_999_999_999)
        throw new ChannelStoreError("CHANNEL_SEQUENCE_EXHAUSTED");
      // The durable high-water is published first. A crash can create a gap,
      // but acknowledgement can never make a sequence reusable.
      await this.atomicReplace(join(d, ".sequence.json"), { sequence });
      const event: ChannelEvent = { ...base, sequence };
      if (
        !(await this.immutable(
          join(d, `${String(sequence).padStart(12, "0")}.json`),
          event,
        ))
      )
        throw new ChannelStoreError("CHANNEL_EVENT_CONFLICT");
      return event;
    } finally {
      await this.releaseAllocator(lock).catch(() => undefined);
    }
  }
  resultPath(runId: string) {
    if (!validRunId(runId)) throw new ChannelStoreError("INVALID_RUN_ID");
    return join(this.resultsDirectory, `${runId}.json`);
  }
  async complete(
    requested: Omit<RunResult, "completedAt">,
  ): Promise<{ result: RunResult; duplicate: boolean }> {
    const result: RunResult = {
        ...requested,
        completedAt: new Date().toISOString(),
      },
      path = this.resultPath(result.runId);
    if (await this.immutable(path, result)) return { result, duplicate: false };
    const existing = await readJson<RunResult>(path);
    const same =
      existing.version === requested.version &&
      existing.domainId === requested.domainId &&
      existing.agentId === requested.agentId &&
      existing.runId === requested.runId &&
      existing.agentGeneration === requested.agentGeneration &&
      existing.assignmentGeneration === requested.assignmentGeneration &&
      existing.status === requested.status &&
      existing.summary === requested.summary &&
      existing.finalResult === requested.finalResult;
    if (!same) throw new ChannelStoreError("COMPLETION_CONFLICT");
    return { result: existing, duplicate: true };
  }
  async cancel(
    requested: Omit<RunResult, "completedAt">,
  ): Promise<{ result: RunResult; cancelled: boolean }> {
    const result: RunResult = {
        ...requested,
        completedAt: new Date().toISOString(),
      },
      path = this.resultPath(result.runId);
    if (await this.immutable(path, result)) return { result, cancelled: true };
    return { result: await readJson<RunResult>(path), cancelled: false };
  }
  async result(runId: string): Promise<RunResult | undefined> {
    try {
      return await readJson<RunResult>(this.resultPath(runId));
    } catch (e) {
      if (e instanceof ChannelStoreError && e.code === "RESULT_NOT_READY")
        return undefined;
      throw e;
    }
  }
  private async migrateLegacyLocked(
    runId: string,
    d: string,
    deliveredFloor: number,
  ): Promise<void> {
      let nativeNames = (await readdir(d))
        .filter((name) => /^\d{12}\.json$/u.test(name))
        .sort();
      const migrated = new Set<string>();
      for (const name of nativeNames) {
        const event = await readJson<ChannelEvent>(join(d, name));
        if (event.legacyEventId) migrated.add(event.legacyEventId);
      }
      const legacy: Array<{ name: string; old: Record<string, unknown> }> = [];
      for (const name of (await readdir(this.eventsDirectory))
        .filter((candidate) => /^[0-9]{13}-[0-9a-f-]{36}\.json$/u.test(candidate))
        .sort()) {
        const old = await readJson<Record<string, unknown>>(
          join(this.eventsDirectory, name),
        );
        if (old.version === 1 && old.runId === runId) legacy.push({ name, old });
      }
      let highWater = 0;
      try {
        const stored = await readJson<{ sequence: number }>(join(d, ".sequence.json"));
        if (!Number.isSafeInteger(stored.sequence) || stored.sequence < 0)
          throw new ChannelStoreError("CHANNEL_RECORD_MALFORMED");
        highWater = stored.sequence;
      } catch (error) {
        if (!(error instanceof ChannelStoreError) || error.code !== "RESULT_NOT_READY")
          throw error;
      }
      highWater = Math.max(
        highWater,
        deliveredFloor,
        nativeNames.length ? Number(nativeNames.at(-1)!.slice(0, 12)) : 0,
      );
      for (const { name, old } of legacy) {
        const legacyEventId = name.slice(0, -5);
        if (migrated.has(legacyEventId)) {
          await unlink(join(this.eventsDirectory, name)).catch((error) => {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
          });
          continue;
        }
        if (nativeNames.length >= MAX_PENDING_PER_RUN) break;
        const sequence = highWater + 1;
        if (!Number.isSafeInteger(sequence) || sequence > 999_999_999_999)
          throw new ChannelStoreError("CHANNEL_SEQUENCE_EXHAUSTED");
        await this.atomicReplace(join(d, ".sequence.json"), { sequence });
        const event: ChannelEvent = {
          version: 2,
          sequence,
          kind: old.kind === "progress" ? "progress" : "message",
          domainId: String(old.domainId),
          agentId: String(old.agentId),
          runId,
          agentGeneration: Number(old.agentGeneration),
          assignmentGeneration: Number(old.assignmentGeneration),
          target: String(old.target),
          summary: String(old.summary),
          createdAt: String(old.createdAt),
          legacyEventId,
        };
        const nativeName = `${String(sequence).padStart(12, "0")}.json`;
        if (!(await this.immutable(join(d, nativeName), event)))
          throw new ChannelStoreError("CHANNEL_EVENT_CONFLICT");
        // Publication is immutable and precedes removal. A crash in between is
        // recovered by legacyEventId de-duplication on the next migration.
        await unlink(join(this.eventsDirectory, name)).catch((error) => {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        });
        nativeNames.push(nativeName);
        migrated.add(legacyEventId);
        highWater = sequence;
      }
  }
  private async migrateLegacy(runId: string, deliveredFloor: number): Promise<void> {
    const d = await this.runDirectory(runId);
    const lock = await this.acquireAllocator(d);
    try {
      await this.migrateLegacyLocked(runId, d, deliveredFloor);
    } finally {
      await this.releaseAllocator(lock).catch(() => undefined);
    }
  }
  async events(
    runIds: string[],
    deliveredFloors: ReadonlyMap<string, number> = new Map(),
    options: { migrateLegacy?: boolean } = {},
  ): Promise<ChannelEvent[]> {
    const events: ChannelEvent[] = [];
    for (const runId of runIds) {
      if (options.migrateLegacy !== false)
        await this.migrateLegacy(runId, deliveredFloors.get(runId) ?? 0);
      const d = await this.runDirectory(runId);
      const names = (await readdir(d))
        .filter((name) => /^\d{12}\.json$/u.test(name))
        .sort()
        .slice(0, MAX_PENDING_PER_RUN);
      for (const name of names)
        events.push(await readJson<ChannelEvent>(join(d, name)));
    }
    return events;
  }
  async discardLegacy(eventIds: string[]): Promise<void> {
    for (const eventId of eventIds)
      if (/^[0-9]{13}-[0-9a-f-]{36}$/u.test(eventId))
        await unlink(join(this.eventsDirectory, `${eventId}.json`)).catch(
          (e) => {
            if ((e as { code?: string }).code !== "ENOENT") throw e;
          },
        );
  }
  async acknowledge(runId: string, through: number): Promise<void> {
    const d = await this.runDirectory(runId);
    for (const name of await readdir(d)) {
      if (/^\d{12}\.json$/u.test(name) && Number(name.slice(0, 12)) <= through)
        await unlink(join(d, name)).catch((e) => {
          if ((e as { code?: string }).code !== "ENOENT") throw e;
        });
    }
    await rm(d, { recursive: false }).catch(() => undefined);
  }
  async waitForChange(
    runIds: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    if (timeoutMs <= 0) return;
    const directories = await Promise.all(
      runIds.map((id) => this.runDirectory(id)),
    );
    await this.ensure();
    const controllers = directories
      .map(() => new AbortController())
      .concat(new AbortController());
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (aborted = false) => {
        if (settled) return;
        settled = true;
        controllers.forEach((c) => c.abort());
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (aborted) reject(signal?.reason ?? new Error("Aborted"));
        else resolve();
      };
      const abort = () => finish(true);
      const timer = setTimeout(() => finish(), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      const consume = async (d: string, signal: AbortSignal) => {
        try {
          for await (const _ of watch(d, { signal })) {
            finish();
            break;
          }
        } catch {
          finish();
        }
      };
      directories.forEach((d, i) => void consume(d, controllers[i]!.signal));
      void consume(this.resultsDirectory, controllers.at(-1)!.signal);
    });
  }
}
