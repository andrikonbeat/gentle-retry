import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildLaunchPlan, findExecutable, shouldAutoContinue } from "../src/launcher.ts";

test("an ordinary interactive launch continues only when auto-resume is enabled", () => {
	assert.deepEqual(buildLaunchPlan({
		targetCommand: "/usr/bin/gentle-shell",
		args: [],
		autoResumeEnabled: true,
		stdinIsTTY: true,
		stdoutIsTTY: true,
	}), { command: "/usr/bin/gentle-shell", args: ["--continue"] });
	assert.deepEqual(buildLaunchPlan({
		targetCommand: "/usr/bin/gentle-shell",
		args: [],
		autoResumeEnabled: false,
		stdinIsTTY: true,
		stdoutIsTTY: true,
	}), { command: "/usr/bin/gentle-shell", args: [] });
});

test("executable discovery accepts real files but not executable directories", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-retry-path-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const directory = join(root, "gentle-shell");
	mkdirSync(directory);
	chmodSync(directory, 0o755);
	assert.equal(findExecutable("gentle-shell", { PATH: `${root}${delimiter}/definitely-missing` }), undefined);
	const file = join(root, "pi");
	writeExecutable(file);
	assert.equal(findExecutable("pi", { PATH: root }), file);
});

function writeExecutable(path: string): void {
	writeFileSync(path, "#!/bin/sh\n");
	chmodSync(path, 0o755);
}

test("explicit arguments and noninteractive launches are never rewritten", () => {
	for (const args of [["--continue"], ["--session", "chosen"], ["--print", "hello"], ["hello"]]) {
		assert.deepEqual(buildLaunchPlan({
			targetCommand: "/usr/bin/pi",
			args,
			autoResumeEnabled: true,
			stdinIsTTY: true,
			stdoutIsTTY: true,
		}), { command: "/usr/bin/pi", args });
	}
	assert.equal(shouldAutoContinue({ args: [], autoResumeEnabled: true, stdinIsTTY: false, stdoutIsTTY: true }), false);
	assert.equal(shouldAutoContinue({ args: [], autoResumeEnabled: true, stdinIsTTY: true, stdoutIsTTY: false }), false);
});
