import { lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, dirname } from "node:path";
import { strictJsonParse, fail } from "./protocol.mjs";

export const AUTHORIZATION_STATEMENT = "OpenSSH configuration, host trust, and remote account permissions are the authority boundary.";

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw fail("SSH_CONFIG_INVALID", `${label} fields are invalid`, { routeAffecting: true });
}
function text(value, maximum, label) {
  if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) throw fail("SSH_CONFIG_INVALID", `${label} is invalid`, { routeAffecting: true });
  return value;
}
export function validatePrivateRegularFile(filePath, allowMissing = false) {
  if (!isAbsolute(filePath)) throw fail("SSH_CONFIG_INVALID", "Private file path must be absolute", { routeAffecting: true });
  try {
    const info = lstatSync(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw fail("SSH_CONFIG_INVALID", "Private file must be owned, regular, non-symlink, and mode 0600", { routeAffecting: true });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") {
      const parent = statSync(dirname(filePath));
      if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) throw fail("SSH_CONFIG_INVALID", "Private file parent is not private", { routeAffecting: true });
      return;
    }
    throw error;
  }
}
export function loadConfig(filePath) {
  if (!filePath) throw fail("SSH_CONFIG_INVALID", "PI_NATIVE_SSH_CONFIG must name a private configuration", { routeAffecting: true });
  validatePrivateRegularFile(filePath);
  const raw = readFileSync(filePath);
  if (raw.length > 32 * 1024) throw fail("SSH_CONFIG_INVALID", "Configuration is too large", { routeAffecting: true });
  const config = strictJsonParse(raw, 32 * 1024);
  exact(config, ["version", "targets", "audit", "limits"], "Configuration");
  if (config.version !== 2) throw fail("SSH_CONFIG_INVALID", "Configuration version is unsupported", { routeAffecting: true });
  if (!config.targets || typeof config.targets !== "object" || Array.isArray(config.targets) || Object.keys(config.targets).length > 32) throw fail("SSH_CONFIG_INVALID", "Targets are invalid", { routeAffecting: true });
  const targets = Object.create(null);
  for (const [name, target] of Object.entries(config.targets)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw fail("SSH_CONFIG_INVALID", "Target name is invalid", { routeAffecting: true });
    exact(target, ["destination", "displayName", "defaultCwd", "authorization"], "Target");
    exact(target.authorization, ["boundary", "confirmed", "statement"], "Authorization");
    if (target.authorization.boundary !== "openssh-and-remote-account" || target.authorization.confirmed !== true || target.authorization.statement !== AUTHORIZATION_STATEMENT) throw fail("SSH_CONFIG_INVALID", "SSH and remote-account authority is not explicitly confirmed", { routeAffecting: true });
    const destination = text(target.destination, 128, "Destination");
    if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/.test(destination) || destination.startsWith("-")) throw fail("SSH_CONFIG_INVALID", "Destination syntax is invalid", { routeAffecting: true });
    const defaultCwd = text(target.defaultCwd, 4096, "Default cwd");
    if (!defaultCwd.startsWith("/")) throw fail("SSH_CONFIG_INVALID", "Default cwd must be absolute", { routeAffecting: true });
    targets[name] = Object.freeze({ name, destination, displayName: text(target.displayName, 128, "Display name"), defaultCwd, authorization: "openssh-and-remote-account" });
  }
  exact(config.audit, ["enabled", "path", "maxBytes"], "Audit");
  if (typeof config.audit.enabled !== "boolean" || !Number.isInteger(config.audit.maxBytes) || config.audit.maxBytes < 4096 || config.audit.maxBytes > 1024 * 1024) throw fail("SSH_CONFIG_INVALID", "Audit settings are invalid", { routeAffecting: true });
  if (config.audit.enabled) validatePrivateRegularFile(text(config.audit.path, 4096, "Audit path"), true); else if (config.audit.path !== null) throw fail("SSH_CONFIG_INVALID", "Disabled audit path must be null", { routeAffecting: true });
  exact(config.limits, ["commandTimeoutMs", "maxTransferBytes"], "Limits");
  if (!Number.isInteger(config.limits.commandTimeoutMs) || config.limits.commandTimeoutMs < 1000 || config.limits.commandTimeoutMs > 300000 || !Number.isInteger(config.limits.maxTransferBytes) || config.limits.maxTransferBytes < 1024 || config.limits.maxTransferBytes > 8 * 1024 * 1024) throw fail("SSH_CONFIG_INVALID", "Limits are invalid", { routeAffecting: true });
  return Object.freeze({ version: 2, targets: Object.freeze(targets), audit: Object.freeze({ ...config.audit }), limits: Object.freeze({ ...config.limits }) });
}
