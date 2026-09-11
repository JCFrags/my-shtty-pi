import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, chmodSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const HISTORY_SCHEMA_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function assertOwner(stat: Stats): void {
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error("GLANCE_HISTORY_UNSAFE_OWNER");
}

export function defaultHistoryDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  const base = environment.XDG_STATE_HOME && environment.XDG_STATE_HOME.startsWith("/")
    ? environment.XDG_STATE_HOME
    : join(homedir(), ".local", "state");
  return join(resolve(base), "pi-project-glance", "archive-v1.sqlite");
}

export function ensurePrivateHistoryPath(path: string): void {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("GLANCE_HISTORY_UNSAFE_DIRECTORY");
  assertOwner(directoryStat);
  if ((directoryStat.mode & 0o7777) !== DIRECTORY_MODE) chmodSync(directory, DIRECTORY_MODE);
  if (!existsSync(path)) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE);
    closeSync(fd);
  }
  const fileStat = lstatSync(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("GLANCE_HISTORY_UNSAFE_FILE");
  assertOwner(fileStat);
  if ((fileStat.mode & 0o7777) !== FILE_MODE) chmodSync(path, FILE_MODE);
}

export function enforcePrivateSqliteFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("GLANCE_HISTORY_UNSAFE_FILE");
    assertOwner(stat);
    if ((stat.mode & 0o7777) !== FILE_MODE) chmodSync(candidate, FILE_MODE);
  }
}

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  history_meta: ["key", "value"], commits: ["seq", "committed_at"], sessions: ["session_key", "source_session_hash", "created_at"],
  source_entries: ["session_key", "entry_id", "parent_id", "source_ordinal", "source_at"],
  items: ["item_pk", "item_id", "session_key", "source_entry_id", "source_kind", "projection_id", "type", "source_at", "source_ordinal", "preview", "body", "body_bytes", "body_digest", "committed_seq"],
  branches: ["branch_id", "session_key", "base_entry_id", "head_entry_id", "created_seq"],
  branch_heads: ["session_key", "entry_id", "branch_id"], branch_entries: ["branch_id", "entry_id"],
  branch_items: ["branch_id", "item_pk", "visible_seq"], archives: ["branch_id", "item_pk", "action_id", "archive_seq", "archived_at", "source"],
  archive_receipts: ["branch_id", "action_id", "item_pk", "archive_seq"], legacy_dismissals: ["session_key", "entry_id", "projection_id", "archived_at"],
  source_checkpoints: ["session_key", "next_ordinal", "last_entry_id", "commit_seq"],
  imports: ["import_id", "session_key", "source_session_hash", "device", "inode", "committed_offset", "committed_size", "next_ordinal", "prefix_digest", "state", "updated_at", "inserted_items", "discovered_branches", "imported_dismissals", "conflicts", "gaps_json"],
};

function validateSchema(database: DatabaseSync): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
    if (required.some((column) => !actual.has(column))) throw new Error("GLANCE_HISTORY_SCHEMA_INVALID");
  }
}

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS commits (seq INTEGER PRIMARY KEY AUTOINCREMENT, committed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (session_key TEXT PRIMARY KEY, source_session_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_entries (
  session_key TEXT NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, source_ordinal INTEGER NOT NULL, source_at TEXT NOT NULL,
  PRIMARY KEY(session_key, entry_id), UNIQUE(session_key, source_ordinal), FOREIGN KEY(session_key) REFERENCES sessions(session_key)
);
CREATE TABLE IF NOT EXISTS items (
  item_pk INTEGER PRIMARY KEY, item_id TEXT NOT NULL UNIQUE, session_key TEXT NOT NULL, source_entry_id TEXT NOT NULL,
  source_kind TEXT NOT NULL, projection_id TEXT NOT NULL, type TEXT NOT NULL, source_at TEXT NOT NULL, source_ordinal INTEGER NOT NULL,
  preview TEXT NOT NULL, body TEXT NOT NULL, body_bytes INTEGER NOT NULL, body_digest TEXT NOT NULL, committed_seq INTEGER NOT NULL,
  UNIQUE(session_key, source_entry_id, source_kind), FOREIGN KEY(session_key, source_entry_id) REFERENCES source_entries(session_key, entry_id),
  FOREIGN KEY(committed_seq) REFERENCES commits(seq)
);
CREATE TABLE IF NOT EXISTS branches (
  branch_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, base_entry_id TEXT, head_entry_id TEXT, created_seq INTEGER NOT NULL,
  FOREIGN KEY(session_key) REFERENCES sessions(session_key), FOREIGN KEY(created_seq) REFERENCES commits(seq)
);
CREATE TABLE IF NOT EXISTS branch_heads (
  session_key TEXT NOT NULL, entry_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  PRIMARY KEY(session_key, entry_id, branch_id), FOREIGN KEY(branch_id) REFERENCES branches(branch_id)
);
CREATE TABLE IF NOT EXISTS branch_entries (
  branch_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(branch_id, entry_id), FOREIGN KEY(branch_id) REFERENCES branches(branch_id)
);
CREATE TABLE IF NOT EXISTS branch_items (
  branch_id TEXT NOT NULL, item_pk INTEGER NOT NULL, visible_seq INTEGER NOT NULL,
  PRIMARY KEY(branch_id, item_pk), FOREIGN KEY(branch_id) REFERENCES branches(branch_id), FOREIGN KEY(item_pk) REFERENCES items(item_pk),
  FOREIGN KEY(visible_seq) REFERENCES commits(seq)
);
CREATE TABLE IF NOT EXISTS archives (
  branch_id TEXT NOT NULL, item_pk INTEGER NOT NULL, action_id TEXT NOT NULL, archive_seq INTEGER NOT NULL,
  archived_at TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('action','legacy')),
  PRIMARY KEY(branch_id, item_pk), UNIQUE(branch_id, action_id), FOREIGN KEY(branch_id) REFERENCES branches(branch_id),
  FOREIGN KEY(item_pk) REFERENCES items(item_pk), FOREIGN KEY(archive_seq) REFERENCES commits(seq)
);
CREATE TABLE IF NOT EXISTS archive_receipts (
  branch_id TEXT NOT NULL, action_id TEXT NOT NULL, item_pk INTEGER NOT NULL, archive_seq INTEGER NOT NULL,
  PRIMARY KEY(branch_id, action_id), FOREIGN KEY(branch_id) REFERENCES branches(branch_id),
  FOREIGN KEY(item_pk) REFERENCES items(item_pk), FOREIGN KEY(archive_seq) REFERENCES commits(seq)
);
CREATE TABLE IF NOT EXISTS legacy_dismissals (
  session_key TEXT NOT NULL, entry_id TEXT NOT NULL, projection_id TEXT NOT NULL, archived_at TEXT NOT NULL,
  PRIMARY KEY(session_key, entry_id), FOREIGN KEY(session_key, entry_id) REFERENCES source_entries(session_key, entry_id)
);
CREATE TABLE IF NOT EXISTS source_checkpoints (
  session_key TEXT PRIMARY KEY, next_ordinal INTEGER NOT NULL, last_entry_id TEXT, commit_seq INTEGER NOT NULL,
  FOREIGN KEY(session_key) REFERENCES sessions(session_key), FOREIGN KEY(commit_seq) REFERENCES commits(seq)
);
CREATE TABLE IF NOT EXISTS imports (
  import_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, source_session_hash TEXT NOT NULL, device INTEGER NOT NULL, inode INTEGER NOT NULL,
  committed_offset INTEGER NOT NULL, committed_size INTEGER NOT NULL, next_ordinal INTEGER NOT NULL, prefix_digest TEXT NOT NULL, state TEXT NOT NULL,
  updated_at TEXT NOT NULL, inserted_items INTEGER NOT NULL DEFAULT 0, discovered_branches INTEGER NOT NULL DEFAULT 0,
  imported_dismissals INTEGER NOT NULL DEFAULT 0, conflicts INTEGER NOT NULL DEFAULT 0, gaps_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS branch_items_page ON branch_items(branch_id, visible_seq, item_pk);
CREATE INDEX IF NOT EXISTS items_source_order ON items(session_key, source_ordinal, item_pk);
CREATE INDEX IF NOT EXISTS archives_page ON archives(branch_id, archive_seq, item_pk);
`;

export function openHistoryDatabase(path = defaultHistoryDatabasePath()): DatabaseSync {
  const resolved = resolve(path);
  ensurePrivateHistoryPath(resolved);
  const database = new DatabaseSync(resolved);
  try {
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > HISTORY_SCHEMA_VERSION) throw new Error("GLANCE_HISTORY_SCHEMA_NEWER");
    database.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    database.exec("PRAGMA journal_mode=WAL;");
    if (version < HISTORY_SCHEMA_VERSION) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(CREATE_SCHEMA);
        validateSchema(database);
        database.exec(`PRAGMA user_version=${HISTORY_SCHEMA_VERSION}`);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* Preserve the original migration failure. */ }
        if (error instanceof Error && error.message.startsWith("GLANCE_HISTORY_")) throw error;
        throw new Error("GLANCE_HISTORY_SCHEMA_INVALID");
      }
    }
    validateSchema(database);
    enforcePrivateSqliteFiles(resolved);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
