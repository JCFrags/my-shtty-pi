import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import type { DurableSourceIdentity } from "./types.ts";
import { fail } from "./validation.ts";

/** Node's statfs omits f_fsid. GNU stat reads it through the inherited, already checked FD.
 * Btrfs mixes the persistent subvolume root ID into f_fsid. Other filesystems do not
 * receive this policy. Clone/temp_fsid mounts can still change identity and refuse.
 */
export async function durableIdentity(handle: FileHandle): Promise<DurableSourceIdentity | undefined> {
  if (process.platform !== "linux") return undefined;
  const filesystem = await statfs(`/proc/self/fd/${handle.fd}`, { bigint: true });
  if (filesystem.type !== 0x9123683en) return undefined;
  const info = await handle.stat({ bigint: true });
  if (info.birthtimeNs <= 0n) fail("state-store-identity-unavailable");
  const filesystemId = await new Promise<string>((resolve, reject) => {
    const child = spawn("/usr/bin/stat", ["--file-system", "--format=%t:%i", "--", "/proc/self/fd/3"], {
      stdio: ["ignore", "pipe", "ignore", handle.fd], env: { LC_ALL: "C" },
    });
    let output = "", refused = false;
    const timer = setTimeout(() => { refused = true; child.kill("SIGKILL"); }, 2000);
    child.stdout!.on("data", (bytes: Buffer) => {
      if (Buffer.byteLength(output) + bytes.length > 128) { refused = true; child.kill("SIGKILL"); }
      else output += bytes.toString("ascii");
    });
    child.once("error", () => { refused = true; });
    child.once("close", (code) => {
      clearTimeout(timer);
      const match = /^9123683e:([a-f0-9]{1,16})\n$/.exec(output);
      if (refused || code !== 0 || !match || /^0+$/.test(match[1]!)) {
        try { fail("state-store-identity-unavailable"); } catch (error) { reject(error); }
      } else resolve(match[1]!);
    });
  });
  return { scheme: "linux-btrfs-statfs-v1", filesystemId, birthtimeNs: String(info.birthtimeNs) };
}
