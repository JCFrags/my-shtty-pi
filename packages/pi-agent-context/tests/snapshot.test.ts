import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSnapshotText,
	formatLocalDate,
	parseOsRelease,
} from "../extensions/snapshot.ts";

const baseFacts = {
	reason: "session start" as const,
	cwd: "/workspace/project",
	environment: "Fedora Linux; kernel linux; architecture x64",
	shell: "/bin/bash",
};

test("parseOsRelease reads quoted and unquoted values", () => {
	assert.deepEqual(parseOsRelease('NAME="Fedora Linux"\nVERSION_ID=43\nIGNORED\n'), {
		NAME: "Fedora Linux",
		VERSION_ID: "43",
	});
});

test("formatLocalDate uses the local calendar date without a time", () => {
	assert.equal(formatLocalDate(new Date(2026, 7, 21, 0, 0, 1)), "2026-08-21");
	assert.equal(formatLocalDate(new Date(2026, 7, 21, 23, 59, 59)), "2026-08-21");
});

test("same-date snapshot bytes remain stable across exact capture times", () => {
	const morning = buildSnapshotText({
		...baseFacts,
		date: formatLocalDate(new Date(2026, 7, 21, 8, 5, 1)),
	});
	const evening = buildSnapshotText({
		...baseFacts,
		date: formatLocalDate(new Date(2026, 7, 21, 22, 58, 59)),
	});
	assert.equal(morning, evening);
	assert.match(morning, /Current local date: 2026-08-21/);
	assert.doesNotMatch(morning, /\d{2}:\d{2}:\d{2}|UTC:|GMT/);
	assert.match(morning, /Fedora Linux; kernel linux; architecture x64/);
	assert.match(morning, /fresh \/bin\/bash in \/workspace\/project/);
});

test("next-date snapshot bytes change", () => {
	const currentDate = buildSnapshotText({ ...baseFacts, date: "2026-08-21" });
	const nextDate = buildSnapshotText({ ...baseFacts, date: "2026-08-22" });
	assert.notEqual(currentDate, nextDate);
	assert.match(nextDate, /Current local date: 2026-08-22/);
});
