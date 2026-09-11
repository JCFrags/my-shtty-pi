import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const CHRONO_VERSION = "2.0.28";
export const CHRONO_PI_API_TARGET = "0.85.1";

function readBounded(url: URL, maximum: number): Buffer {
  const fd = openSync(url, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maximum) throw new Error("identity-input-invalid");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximum || (info.size > 0 && length !== info.size)) throw new Error("identity-input-changed");
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}

/** Capture immutable deployment bytes when this extension module is evaluated.
 * This is not a live-file recheck, source-commit claim, or coverage certificate.
 */
export function captureRuntimeIdentity(entrypoint: string) {
  const common = { version: CHRONO_VERSION, piApiTarget: CHRONO_PI_API_TARGET, nodeVersion: process.versions.node, pid: process.pid };
  try {
    const url = new URL(entrypoint);
    if (!url.pathname.endsWith("/dist/src/pi-extension.js")) throw new Error("identity-not-built");
    const root = new URL("../../", url);
    const metadata = JSON.parse(readBounded(new URL("package.json", root), 32_768).toString("utf8"));
    if (metadata.name !== "pi-chrono-compact" || metadata.version !== CHRONO_VERSION) throw new Error("identity-version-mismatch");
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const stat = readBounded(new URL("file:///proc/self/stat"), 8_192).toString("utf8");
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
    const boot = readBounded(new URL("file:///proc/sys/kernel/random/boot_id"), 128).toString("utf8").trim();
    if (!/^\d+$/.test(ticks ?? "") || !/^[0-9a-f-]{36}$/.test(boot)) throw new Error("identity-process-invalid");
    return Object.freeze({ ...common, state: "captured" as const, processStart: `${boot}:${ticks}`,
      entrypointSha256: digest(readBounded(url, 1_048_576)),
      deploymentManifestSha256: digest(readBounded(new URL("DEPLOYED.sha256", root), 131_072)) });
  } catch {
    return Object.freeze({ ...common, state: "unverified" as const });
  }
}
