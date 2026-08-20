import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { encodeFrame, decodeSingleFrame, validateResponse, fail, MAX_HELPER_BYTES, MAX_RESPONSE_BYTES, MAX_STDERR_BYTES } from "./protocol.mjs";

export const STRICT_SSH_ARGS = [
  "-o", "BatchMode=yes",
  "-o", "NumberOfPasswordPrompts=0",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ForwardAgent=no",
  "-o", "ClearAllForwardings=yes",
  "-o", "PermitLocalCommand=no",
  "-o", "RequestTTY=no",
  "-o", "ConnectTimeout=5",
  "-o", "ServerAliveInterval=3",
  "-o", "ServerAliveCountMax=1",
];

export const BOOTSTRAP_COMMAND = "exec python3 -c 'import sys,struct;r=sys.stdin.buffer;h=r.read(4);n=struct.unpack(\">I\",h)[0];c=r.read(n);exec(compile(c,\"<pi-remote-helper>\",\"exec\"),{\"__name__\":\"__main__\"})'";

function classifySsh(code, diagnostic) {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(diagnostic)) return fail("HOST_KEY_CHANGED", "Strict host-key verification found a changed key", { recommendedAction: "inspect_config", routeAffecting: true });
  if (/host key verification failed|no .*host key is known|No ED25519 host key is known/i.test(diagnostic)) return fail("HOST_KEY_REQUIRED", "Strict host-key verification requires an existing trusted key", { recommendedAction: "inspect_config", routeAffecting: true });
  if (/permission denied|authentication/i.test(diagnostic)) return fail("AUTH_REQUIRED", "Non-interactive SSH authentication failed", { recommendedAction: "use_terminal", routeAffecting: true });
  return fail("REMOTE_UNREACHABLE", `SSH transport failed with exit ${code ?? "null"}`, { retryable: true, recommendedAction: "retry", routeAffecting: true });
}

export class SshTransport {
  constructor(helperSource, options = {}) {
    this.helper = Buffer.from(helperSource, "utf8");
    if (this.helper.length > MAX_HELPER_BYTES) throw fail("REMOTE_OUTPUT_LIMIT", "Remote helper source exceeds its bound", { routeAffecting: true });
    this.spawn = options.spawn ?? nodeSpawn;
    this.sshBinary = options.sshBinary ?? "/usr/bin/ssh";
    this.extraArgs = options.extraArgs ?? [];
    this.killGraceMs = options.killGraceMs ?? 250;
  }
  async request(target, operation, args, options = {}) {
    const id = randomBytes(8).toString("hex");
    const requestFrame = encodeFrame({ version: 2, id, operation, args });
    const helperHeader = Buffer.allocUnsafe(4);
    helperHeader.writeUInt32BE(this.helper.length);
    const stdin = Buffer.concat([helperHeader, this.helper, requestFrame]);
    const timeoutMs = options.timeoutMs ?? 10_000;
    const signal = options.signal;
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(fail("REMOTE_CANCELLED", "Operation was cancelled before SSH started"));
      const argv = [...STRICT_SSH_ARGS, ...this.extraArgs, "--", target.destination, BOOTSTRAP_COMMAND];
      const child = this.spawn(this.sshBinary, argv, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let reason = null;
      let stopStarted = false;
      let killTimer;
      let settled = false;
      const priority = { output: 1, timeout: 2, cancelled: 3 };
      const setReason = (next) => { if (!reason || priority[next] > priority[reason]) reason = next; };
      const stop = (next) => {
        setReason(next);
        if (stopStarted) return;
        stopStarted = true;
        child.stdout?.pause();
        child.stderr?.pause();
        if (child.pid) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
          killTimer = setTimeout(() => {
            if (child.exitCode === null) {
              try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
            }
          }, this.killGraceMs);
          killTimer.unref?.();
        }
      };
      const timer = setTimeout(() => stop("timeout"), Math.max(1, timeoutMs));
      const onAbort = () => stop("cancelled");
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
      };
      child.stdout?.on("data", (chunk) => {
        if (stopStarted) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_RESPONSE_BYTES + 4) { stop("output"); return; }
        stdout.push(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        if (stopStarted) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) { stop("output"); return; }
        stderr.push(chunk);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error?.code === "ENOENT" ? fail("SSH_BINARY_MISSING", "OpenSSH binary is missing", { routeAffecting: true }) : fail("REMOTE_UNREACHABLE", "SSH process could not start", { routeAffecting: true }));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        const safe = { code, reason, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutBytes, stderrBytes, durationMs: Date.now() - started };
        resolve(safe);
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    });
    if (result.reason === "cancelled") throw fail("REMOTE_CANCELLED", "Operation was cancelled; remote rollback is not claimed");
    if (result.reason === "timeout") throw fail("REMOTE_TIMEOUT", "Operation timed out; remote rollback is not claimed", { retryable: true, recommendedAction: "retry" });
    if (result.reason === "output") throw fail("REMOTE_OUTPUT_LIMIT", "SSH output exceeded its bound", { routeAffecting: true });
    const diagnostic = result.stderr.toString("utf8").slice(0, MAX_STDERR_BYTES);
    if (result.code !== 0) throw classifySsh(result.code, diagnostic);
    if (result.stderr.length !== 0) throw fail("REMOTE_COMMAND_FAILED", "Remote helper produced an unexpected diagnostic", { routeAffecting: true });
    const value = decodeSingleFrame(result.stdout);
    return { result: validateResponse(value, id, operation), meta: { durationMs: result.durationMs, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes } };
  }
}
