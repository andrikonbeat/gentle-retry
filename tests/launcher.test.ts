import assert from "node:assert/strict";
import test from "node:test";
import { buildLaunchPlan, shouldAutoContinue } from "../src/launcher.ts";

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
