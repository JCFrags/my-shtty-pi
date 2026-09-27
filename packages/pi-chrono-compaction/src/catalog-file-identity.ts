import { execFileSync } from "node:child_process";
import type { BigIntStats } from "node:fs";

/** Durable identity is separate from the device/inode observation of one open.
 * Btrfs statfs includes the subvolume root ID. Other filesystems keep the strict
 * device/inode rule. This is not a portable filesystem UUID or a clone guarantee.
 */
export type CatalogFileIdentity =
  | { version: 1; kind: "linux-btrfs-statfs"; fsType: "9123683e"; fsid: string; inode: string; birthtimeNs: string }
  | { version: 1; kind: "device-inode"; device: string; inode: string };
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,39})$/.test(value);
export function isCatalogFileIdentity(value: unknown): value is CatalogFileIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const x = value as Record<string, unknown>;
  if (x.version !== 1 || !decimal(x.inode)) return false;
  if (x.kind === "device-inode") return Object.keys(x).sort().join(",") === "device,inode,kind,version" && decimal(x.device);
  return x.kind === "linux-btrfs-statfs" && Object.keys(x).sort().join(",") === "birthtimeNs,fsType,fsid,inode,kind,version"
    && x.fsType === "9123683e" && typeof x.fsid === "string" && /^[a-f0-9]{1,16}$/.test(x.fsid) && !/^0+$/.test(x.fsid)
    && decimal(x.birthtimeNs) && x.birthtimeNs !== "0";
}
export function sameCatalogFileIdentity(left: CatalogFileIdentity, right: CatalogFileIdentity): boolean {
  if (!isCatalogFileIdentity(left) || !isCatalogFileIdentity(right) || left.kind !== right.kind || left.inode !== right.inode) return false;
  if (left.kind === "device-inode" && right.kind === "device-inode") return left.device === right.device;
  return left.kind === "linux-btrfs-statfs" && right.kind === "linux-btrfs-statfs"
    && left.fsType === right.fsType && left.fsid === right.fsid && left.birthtimeNs === right.birthtimeNs;
}
/** Fixed executable/arguments, inherited pinned descriptor, bounded output/time.
 * No source pathname is reopened and no provider or session state is accessed.
 */
export function captureCatalogFileIdentity(fd: number, stat: BigIntStats): CatalogFileIdentity {
  const strict: CatalogFileIdentity = { version: 1, kind: "device-inode", device: String(stat.dev), inode: String(stat.ino) };
  if (process.platform !== "linux") return strict;
  let output: string;
  try {
    output = execFileSync("/usr/bin/stat", ["--file-system", "--format=%t %i", "--", "/proc/self/fd/3"], {
      stdio: ["ignore", "pipe", "pipe", fd], env: { LC_ALL: "C" }, timeout: 1000, maxBuffer: 128,
    }).toString("ascii");
  } catch { throw Object.assign(new Error("catalog-source-identity-unavailable"), { code: "catalog-source-identity-unavailable" }); }
  const match = /^([a-f0-9]{1,16}) ([a-f0-9]{1,16})\n$/.exec(output);
  if (!match) throw Object.assign(new Error("catalog-source-identity-unavailable"), { code: "catalog-source-identity-unavailable" });
  if (match[1] !== "9123683e") return strict;
  const identity: CatalogFileIdentity = { version: 1, kind: "linux-btrfs-statfs", fsType: "9123683e", fsid: match[2]!,
    inode: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
  if (!isCatalogFileIdentity(identity)) throw Object.assign(new Error("catalog-source-identity-unavailable"), { code: "catalog-source-identity-unavailable" });
  return identity;
}
