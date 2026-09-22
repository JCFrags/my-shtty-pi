import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import type { PrincipalConfig, ServiceConfig } from "../contracts.ts";
import { fail, id, integer, noteFields, object, text, version } from "../core/validation.ts";

/** Read once through a non-symlink descriptor and reject group/world access. */
export function readProtectedFile(path: string): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return fail("protected_file_unavailable", "Cannot open the configured protected file. Check its path, owner, and mode."); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) fail("unsafe_file", "Config and token files must be regular files owned by this user with mode 0600 or 0400.");
    if (info.size > 131_072) fail("file_too_large", "Protected config or token file exceeds 128 KiB.");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
export function readTokenFile(path: string): string {
  const token = readProtectedFile(path).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) fail("invalid_token_file", "Token file must contain one 32–256 character base64url token. Generate a random 32-byte token.");
  return token;
}
export function loadConfig(path: string): ServiceConfig {
  let value: unknown;
  try { value = JSON.parse(readProtectedFile(path)); }
  catch (error) { if (error instanceof SyntaxError) fail("invalid_config", "Service config is not valid JSON."); throw error; }
  const config = validateConfig(value);
  const base = dirname(resolve(path));
  config.database = resolve(base, config.database);
  config.principals = config.principals.map(principal => ({ ...principal, tokenFile: resolve(base, principal.tokenFile) }));
  if (config.unixSocket) config.unixSocket = { ...config.unixSocket, path: resolve(base, config.unixSocket.path) };
  return config;
}
export function validateConfig(value: unknown): ServiceConfig {
  const config = object(value, "config", ["schemaVersion", "serviceId", "database", "host", "port", "unixSocket", "principals", "note"]);
  version(config); id(config.serviceId, "serviceId"); text(config.database, "database"); noteFields(config.note);
  if (config.database === ":memory:") fail("invalid_config", "The HTTP service requires a durable database file.");
  if (config.host !== undefined && !["127.0.0.1", "::1"].includes(config.host)) fail("unsafe_bind", "Only 127.0.0.1 or ::1 listeners are supported. Use a protected SSH forward.");
  if (config.port !== undefined) integer(config.port, "port", 0, 65535);
  if (config.unixSocket !== undefined) {
    const socket = object(config.unixSocket, "unixSocket", ["path", "mode", "groupId"]);
    text(socket.path, "unixSocket.path", 100);
    if (socket.mode !== undefined && ![0o600, 0o660].includes(socket.mode)) fail("unsafe_socket_mode", "Unix socket mode must be 384 (0600) or 432 (0660).");
    if (socket.groupId !== undefined) integer(socket.groupId, "unixSocket.groupId", 0, 2 ** 31 - 1);
    if (socket.mode === 0o660 && socket.groupId === undefined) fail("missing_socket_group", "A 0660 socket requires an explicit groupId.");
  }
  if (!Array.isArray(config.principals) || config.principals.length < 1 || config.principals.length > 64) fail("invalid_config", "Configure 1–64 principals.");
  const ids = new Set<string>();
  config.principals.forEach((value: unknown) => {
    const p = object(value, "principal", ["id", "tokenFile", "roles", "sourceIds", "destinationIds"]);
    id(p.id, "principal.id"); text(p.tokenFile, "principal.tokenFile");
    if (ids.has(p.id)) fail("invalid_config", "Principal IDs must be unique."); ids.add(p.id);
    if (!Array.isArray(p.roles) || !p.roles.length || p.roles.some((role: unknown) => !["admin", "producer", "consumer", "scheduler", "reader"].includes(role as string))) fail("invalid_config", "Principal roles must use admin, producer, consumer, scheduler, or reader.");
    for (const name of ["sourceIds", "destinationIds"]) {
      if (p[name] !== undefined) {
        if (!Array.isArray(p[name]) || p[name].length > 128) fail("invalid_config", `${name} must be an array of at most 128 IDs.`);
        p[name].forEach((value: unknown) => { if (value !== "*") id(value, name); });
      }
    }
    if (!p.roles.includes("admin")) {
      if ((p.roles.includes("consumer") || p.roles.includes("scheduler") || p.roles.includes("reader")) && !p.destinationIds?.length) fail("missing_scope", "Non-admin consumers, schedulers, and readers require destinationIds.");
      if (p.roles.includes("producer") && !p.sourceIds?.length) fail("missing_scope", "Non-admin producers require sourceIds.");
    }
  });
  return config as ServiceConfig;
}
const digest = (value: string) => createHash("sha256").update(value).digest();
export class Authenticator {
  #principals: { principal: PrincipalConfig; digest: Buffer }[];
  constructor(config: ServiceConfig) {
    const seen = new Set<string>();
    this.#principals = config.principals.map(principal => {
      const value = digest(readTokenFile(principal.tokenFile));
      if (seen.has(value.toString("hex"))) fail("duplicate_token", "Each principal must have a distinct token file value.");
      seen.add(value.toString("hex"));
      return { principal, digest: value };
    });
  }
  authenticate(header: string | undefined): PrincipalConfig {
    if (!header?.startsWith("Bearer ") || header.length > 512) fail("unauthorized", "A valid Bearer token is required.", 401);
    const received = digest(header.slice(7));
    const found = this.#principals.find(item => timingSafeEqual(received, item.digest));
    if (!found) fail("unauthorized", "A valid Bearer token is required.", 401);
    return found.principal;
  }
}
export function requireRole(principal: PrincipalConfig, ...roles: PrincipalConfig["roles"]): void {
  if (!principal.roles.includes("admin") && !roles.some(role => principal.roles.includes(role))) fail("forbidden", "The token does not permit this operation.", 403);
}
export function requireDestination(principal: PrincipalConfig, destinationId: string) {
  if (!principal.roles.includes("admin") && !principal.destinationIds?.some(id => id === "*" || id === destinationId)) fail("destination_forbidden", "The token does not permit this destination.", 403);
}
export function requireSource(principal: PrincipalConfig, source: string) {
  if (!principal.roles.includes("admin") && !principal.sourceIds?.some(id => id === "*" || id === source)) fail("source_forbidden", "The token does not permit this event source.", 403);
}
export function allowedDestinations(principal: PrincipalConfig): string[] | undefined {
  return principal.roles.includes("admin") ? undefined : principal.destinationIds ?? [];
}
