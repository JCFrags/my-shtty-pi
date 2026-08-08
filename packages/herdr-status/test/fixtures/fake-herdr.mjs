#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const sleepMs = Number(process.env.FAKE_HERDR_SLEEP_MS ?? "0");
if (sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}

if (args.join(" ") === "api schema --json") {
  if (process.env.FAKE_HERDR_BAD_SCHEMA === "1") {
    process.stdout.write("{not-json");
    process.exit(0);
  }
  const includeSequence = process.env.FAKE_HERDR_NO_SEQ !== "1";
  const properties = {
    tokens: {
      additionalProperties: { type: ["string", "null"] },
      maxProperties: 16,
    },
    ttl_ms: { type: ["integer", "null"], minimum: 1, maximum: 86400000 },
  };
  if (includeSequence) properties.seq = { type: ["integer", "null"], minimum: 0 };
  process.stdout.write(
    JSON.stringify({
      schemas: {
        request: {
          $defs: {
            PaneReportMetadataParams: { properties },
          },
        },
      },
    }),
  );
  process.exit(0);
}

if (args[0] === "pane" && args[1] === "report-metadata" && args.includes("--help")) {
  const sequence = process.env.FAKE_HERDR_NO_SEQ === "1" ? "" : " [--seq N]";
  process.stdout.write(
    `report-metadata <pane_id> --source ID --token NAME=VALUE --clear-token NAME${sequence} --ttl-ms N\n`,
  );
  process.exit(0);
}

if (process.env.FAKE_HERDR_LOG) {
  appendFileSync(
    process.env.FAKE_HERDR_LOG,
    `${JSON.stringify({ argv: args, at: Date.now() })}\n`,
    "utf8",
  );
}

const outputBytes = Number(process.env.FAKE_HERDR_OUTPUT_BYTES ?? "0");
if (outputBytes > 0) process.stdout.write("x".repeat(outputBytes));

const exitCode = Number(process.env.FAKE_HERDR_EXIT_CODE ?? "0");
process.exit(Number.isFinite(exitCode) ? exitCode : 1);
