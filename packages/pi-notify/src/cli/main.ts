import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { NotifyClient, NotifyError } from "../client.ts";
import { loadConfig, readTokenFile } from "../server/config.ts";
import { startServer } from "../server/index.ts";
import { fail, id, integer, ServiceError } from "../core/validation.ts";
import type { ListOptions, ServiceConfig } from "../contracts.ts";

const help = `Pi-Notify: standalone durable events and scheduling (Node 24.18+)

  pi-notify init --dir PRIVATE_DIRECTORY [--service-id local] [--port 7734]
  pi-notify serve --config PRIVATE_CONFIG
  pi-notify [--url URL] --token-file FILE health
  pi-notify [connection options] create-destination --file JSON_FILE
  pi-notify [connection options] create-job --file JSON_FILE
  pi-notify [connection options] publish --file JSON_FILE
  pi-notify [connection options] list destinations|jobs|deliveries|notes
  pi-notify [connection options] inspect destination|job|delivery|note ID
  pi-notify [connection options] pause|resume|cancel JOB_ID
  pi-notify [connection options] note --file JSON_FILE

List options: --limit 1..100 --offset N --destination ID --job ID
Connection defaults: PI_NOTIFY_URL (http://127.0.0.1:7734), PI_NOTIFY_TOKEN_FILE.
Token values are never accepted on the command line. JSON receipts go to stdout.
Acceptance is not completion. Do not poll, sleep, or wait in an agent turn.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      help: { type: "boolean", short: "h" }, url: { type: "string" }, "token-file": { type: "string" },
      config: { type: "string" }, dir: { type: "string" }, "service-id": { type: "string" }, port: { type: "string" },
      file: { type: "string" }, limit: { type: "string" }, offset: { type: "string" }, destination: { type: "string" }, job: { type: "string" },
    } });
    const [command, kind, identity] = positionals;
    if (!command || values.help) { process.stdout.write(help); return; }
    if (command === "init") {
      if (!values.dir) fail("missing_directory", "init requires --dir for a new private directory.");
      const dir = resolve(values.dir); const serviceId = values["service-id"] ?? "local"; id(serviceId, "service-id");
      const port = Number(values.port ?? 7734); integer(port, "port", 1, 65535);
      // Deliberately refuse any existing directory. Never replace an operator's files.
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, "admin.token"), `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
      const config: ServiceConfig = {
        schemaVersion: 1, serviceId, database: "state/notify.sqlite", host: "127.0.0.1", port,
        principals: [{ id: "operator", tokenFile: "admin.token", roles: ["admin"] }],
        note: { purpose: "Persist events, schedules, and delivery outcomes.", owner: "service-operator", references: [], repairContext: "Inspect jobs, deliveries, and current service instance before repair. Keep the stopped database and WAL together for backup. Never identify a process by PID alone." },
      };
      writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      print({ schemaVersion: 1, configFile: join(dir, "config.json"), tokenFile: join(dir, "admin.token"), next: "Review the protected config, then run serve --config CONFIG_FILE. Use separate scoped tokens for integrations." });
      return;
    }
    if (command === "serve") {
      const path = values.config ?? process.env.PI_NOTIFY_CONFIG;
      if (!path) fail("missing_config", "serve requires --config or PI_NOTIFY_CONFIG.");
      const running = await startServer(loadConfig(resolve(path)), { onError: code => process.stderr.write(`${code}: inspect protected service storage and configuration.\n`) });
      print({ ...running.health, baseUrl: running.baseUrl });
      let stopping = false;
      const stop = () => {
        if (stopping) return; stopping = true;
        void running.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
      };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      return;
    }
    const tokenFile = values["token-file"] ?? process.env.PI_NOTIFY_TOKEN_FILE;
    if (!tokenFile) fail("missing_token_file", "Use --token-file or PI_NOTIFY_TOKEN_FILE. Do not pass raw tokens in arguments.");
    const client = new NotifyClient({ baseUrl: values.url ?? process.env.PI_NOTIFY_URL ?? "http://127.0.0.1:7734", token: readTokenFile(resolve(tokenFile)) });
    const input = () => {
      if (!values.file) fail("missing_input", "This command requires --file with a JSON contract.");
      const content = readFileSync(resolve(values.file), "utf8");
      if (Buffer.byteLength(content) > 131_072) fail("body_too_large", "JSON input exceeds 128 KiB.");
      try { return JSON.parse(content); } catch { return fail("invalid_json", "Input file is not valid JSON."); }
    };
    if (command === "health") { print(await client.health()); return; }
    if (command === "create-destination") { print(await client.createDestination(input())); return; }
    if (command === "create-job") { print(await client.createJob(input())); return; }
    if (command === "publish") { print(await client.publishEvent(input())); return; }
    if (command === "note") { print(await client.putNote(input())); return; }
    if (command === "list") {
      const options: ListOptions = {};
      if (values.limit !== undefined) options.limit = Number(values.limit);
      if (values.offset !== undefined) options.offset = Number(values.offset);
      if (values.destination) options.destinationId = values.destination;
      if (values.job) options.jobId = values.job;
      if (kind === "destinations") print(await client.listDestinations(options));
      else if (kind === "jobs") print(await client.listJobs(options));
      else if (kind === "deliveries") print(await client.listDeliveries(options));
      else if (kind === "notes") print(await client.listNotes(options));
      else fail("invalid_resource", "List destinations, jobs, deliveries, or notes.");
      return;
    }
    if (command === "inspect") {
      if (!identity) fail("missing_id", "inspect requires a resource kind and exact ID.");
      if (kind === "destination") print(await client.getDestination(identity));
      else if (kind === "job") print(await client.getJob(identity));
      else if (kind === "delivery") print(await client.getDelivery(identity));
      else if (kind === "note") print(await client.getNote(identity));
      else fail("invalid_resource", "Inspect destination, job, delivery, or note.");
      return;
    }
    if (command === "pause" || command === "resume" || command === "cancel") {
      if (!kind) fail("missing_id", `${command} requires a job ID.`);
      print(await client.controlJob(kind, command)); return;
    }
    fail("unknown_command", "Unknown command. Use --help for the supported commands.");
  } catch (error) {
    const known = error instanceof ServiceError || error instanceof NotifyError;
    const code = known ? error.code : "cli_failed";
    const message = known ? error.message : "Command failed. Check arguments, file ownership, and the service address. No acceptance receipt was confirmed.";
    process.stderr.write(`${JSON.stringify({ schemaVersion: 1, error: { code, message } })}\n`);
    process.exitCode = 1;
  }
}
function print(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
