import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { SshTransport } from "../src/transport.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitPort(port) {
  for (let count = 0; count < 100; count++) {
    if (await new Promise(resolve => { const socket = connect(port, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); })) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("fixture sshd did not start");
}
function key(path) { execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path], { stdio: "ignore" }); }

test("isolated SSH fixture classifies unknown, changed, and authentication failures", { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-sshd-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const hostKey = join(root, "host");
  const clientKey = join(root, "client");
  const wrongKey = join(root, "wrong");
  const changedKey = join(root, "changed");
  key(hostKey); key(clientKey); key(wrongKey); key(changedKey);
  const authorized = join(root, "authorized_keys");
  await writeFile(authorized, await readFile(`${clientKey}.pub`), { mode: 0o600 });
  const port = await freePort();
  const username = userInfo().username;
  const config = join(root, "sshd_config");
  await writeFile(config, [
    `Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${hostKey}`, `PidFile ${join(root, "sshd.pid")}`,
    `AuthorizedKeysFile ${authorized}`, `AllowUsers ${username}`, "StrictModes no", "PasswordAuthentication no",
    "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", "AuthenticationMethods publickey", "UsePAM no", "LogLevel ERROR",
  ].join("\n") + "\n", { mode: 0o600 });
  execFileSync("/usr/sbin/sshd", ["-t", "-f", config]);
  const daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] });
  const daemonErrors = []; daemon.stderr.on("data", chunk => daemonErrors.push(chunk));
  t.after(() => { if (daemon.exitCode === null) daemon.kill("SIGTERM"); });
  await waitPort(port);

  const helper = await readFile(new URL("../src/helper.py", import.meta.url), "utf8");
  const known = join(root, "known_hosts");
  await writeFile(known, "", { mode: 0o600 });
  const common = ["-p", String(port), "-o", `UserKnownHostsFile=${known}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-o", "LogLevel=ERROR"];
  const target = { name: "fixture", destination: `${username}@127.0.0.1` };

  const acceptedTransport = () => new SshTransport(helper, { extraArgs: [...common, "-i", clientKey] });
  const unknown = acceptedTransport();
  await assert.rejects(() => unknown.request(target, "capabilities", {}, { timeoutMs: 3000 }), error => error.code === "HOST_KEY_REQUIRED" && !/fingerprint|SHA256:/.test(error.message));

  const publicHost = execFileSync("ssh-keygen", ["-y", "-f", hostKey], { encoding: "utf8" }).trim();
  await writeFile(known, `[127.0.0.1]:${port} ${publicHost}\n`, { mode: 0o600 });
  const accepted = await unknown.request(target, "capabilities", {}, { timeoutMs: 3000 });
  assert.equal(accepted.result.authorization, "remote-account");

  const publicChanged = execFileSync("ssh-keygen", ["-y", "-f", changedKey], { encoding: "utf8" }).trim();
  await writeFile(known, `[127.0.0.1]:${port} ${publicChanged}\n`, { mode: 0o600 });
  await assert.rejects(() => unknown.request(target, "capabilities", {}, { timeoutMs: 3000 }), error => error.code === "HOST_KEY_CHANGED" && !/fingerprint|SHA256:/.test(error.message));

  await writeFile(known, `[127.0.0.1]:${port} ${publicHost}\n`, { mode: 0o600 });
  const auth = new SshTransport(helper, { extraArgs: [...common, "-i", wrongKey] });
  await assert.rejects(() => auth.request(target, "capabilities", {}, { timeoutMs: 3000 }), error => error.code === "AUTH_REQUIRED" && !/fingerprint|SHA256:/.test(error.message));

  const clientPublic = (await readFile(`${clientKey}.pub`, "utf8")).trim();
  await writeFile(authorized, `command="yes x | head -c ${48 * 1024 * 1024 + 5}" ${clientPublic}\n`, { mode: 0o600 });
  await assert.rejects(() => acceptedTransport().request(target, "capabilities", {}, { timeoutMs: 5000 }), error => error.code === "REMOTE_OUTPUT_LIMIT");
  assert.equal(Buffer.concat(daemonErrors).toString("utf8").includes("PRIVATE KEY"), false);
});
