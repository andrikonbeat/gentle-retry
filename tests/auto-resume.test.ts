import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

// Run the focused tests against TypeScript sources without writing build output
// outside the task's allowed edit surfaces.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const {
	AUTO_RESUME_PROMPT,
	decideAutoResume,
	detectInterruptedTurn,
	readAutoResumeMarker,
	writeAutoResumeMarker,
	autoResumeMarkerPath,
} = await import("../src/auto-resume.ts");

const scratchDirectories: string[] = [];

afterEach(() => {
	for (const directory of scratchDirectories.splice(0).reverse()) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {}
	}
});

function scratch(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	scratchDirectories.push(directory);
	return directory;
}

const USER = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

const ASSISTANT = (stopReason: string) => ({
	role: "assistant",
	content: [{ type: "text", text: "partial" }],
	stopReason,
	timestamp: 0,
});

const entry = (id: string, message: unknown) => ({ id, type: "message", message });

test("a branch without a user message has no interrupted turn", () => {
	assert.deepEqual(detectInterruptedTurn([]), { interrupted: false });
	assert.deepEqual(detectInterruptedTurn([entry("entry-assistant", ASSISTANT("stop"))]), { interrupted: false });
	assert.deepEqual(detectInterruptedTurn([{ id: "weird" }, null, 42]), { interrupted: false });
});

test("a user message without an assistant reply is an interrupted turn", () => {
	const turn = detectInterruptedTurn([entry("entry-user", USER("keep going"))]);
	assert.equal(turn.interrupted, true);
	if (!turn.interrupted) return;
	assert.equal(turn.entryId, "entry-user");
	assert.equal(turn.userText, "keep going");
});

test("an assistant reply that ended the turn is not interrupted", () => {
	for (const stopReason of ["stop", "length", "aborted", "error", "deferred"]) {
		const turn = detectInterruptedTurn([entry("entry-user", USER("hi")), entry("entry-assistant", ASSISTANT(stopReason))]);
		assert.deepEqual(turn, { interrupted: false }, `stopReason ${stopReason} must not auto-resume`);
	}
});

test("an assistant reply that was still running is interrupted", () => {
	for (const stopReason of ["pending", "toolUse"]) {
		const turn = detectInterruptedTurn([entry("entry-user", USER("hi")), entry("entry-assistant", ASSISTANT(stopReason))]);
		assert.equal(turn.interrupted, true, `stopReason ${stopReason} must auto-resume`);
	}
});

test("the last user message wins over older replies", () => {
	const turn = detectInterruptedTurn([
		entry("entry-user-old", USER("old")),
		entry("entry-assistant-old", ASSISTANT("stop")),
		entry("entry-user-new", USER("new")),
	]);
	assert.equal(turn.interrupted, true);
	if (!turn.interrupted) return;
	assert.equal(turn.entryId, "entry-user-new");
	assert.equal(turn.userText, "new");
});

test("a user message sent as plain text is read", () => {
	const turn = detectInterruptedTurn([entry("entry-user", { role: "user", content: "plain", timestamp: 0 })]);
	assert.equal(turn.interrupted, true);
	if (!turn.interrupted) return;
	assert.equal(turn.userText, "plain");
});

const decisionInput = {
	autoResumeEnabled: true,
	policyMalformed: false,
	sessionMode: "tui",
	startReason: "resume",
	entries: [entry("entry-user", USER("keep going"))],
	marker: undefined,
	sessionId: "session-a",
};

test("auto-resume stays disabled unless it is explicitly enabled", () => {
	const decision = decideAutoResume({ ...decisionInput, autoResumeEnabled: false });
	assert.deepEqual(decision, { resume: false, reason: "disabled" });
});

test("a malformed policy keeps auto-resume disabled", () => {
	const decision = decideAutoResume({ ...decisionInput, policyMalformed: true });
	assert.deepEqual(decision, { resume: false, reason: "malformed-policy" });
});

test("auto-resume only runs in an interactive terminal session", () => {
	const decision = decideAutoResume({ ...decisionInput, sessionMode: "rpc" });
	assert.deepEqual(decision, { resume: false, reason: "not-tui" });
});

test("only the resume and startup reasons may auto-resume", () => {
	for (const reason of ["new", "fork"]) {
		const decision = decideAutoResume({ ...decisionInput, startReason: reason });
		assert.deepEqual(decision, { resume: false, reason: "wrong-reason" }, `reason ${reason} must not auto-resume`);
	}
});

test("a completed turn is not resumed", () => {
	const decision = decideAutoResume({
		...decisionInput,
		entries: [entry("entry-user", USER("hi")), entry("entry-assistant", ASSISTANT("stop"))],
	});
	assert.deepEqual(decision, { resume: false, reason: "nothing-to-resume" });
});

test("an interrupted turn resumes with the continuation prompt", () => {
	const decision = decideAutoResume(decisionInput);
	assert.equal(decision.resume, true);
	if (!decision.resume) return;
	assert.equal(decision.entryId, "entry-user");
	assert.equal(decision.prompt, AUTO_RESUME_PROMPT);
});

test("a turn that already carries the continuation prompt is never continued twice", () => {
	const decision = decideAutoResume({
		...decisionInput,
		entries: [entry("entry-user", USER("keep going")), entry("entry-continuation", USER(AUTO_RESUME_PROMPT))],
	});
	assert.deepEqual(decision, { resume: false, reason: "already-continued" });
});

test("the durable marker blocks a second continuation of the same turn", () => {
	const marker = {
		schema: "gentle-pi.retry-auto-resume/v1",
		sessionId: "session-a",
		entryId: "entry-user",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const decision = decideAutoResume({ ...decisionInput, marker });
	assert.deepEqual(decision, { resume: false, reason: "already-continued" });
});

test("a marker from another session does not block the continuation", () => {
	const marker = {
		schema: "gentle-pi.retry-auto-resume/v1",
		sessionId: "session-b",
		entryId: "entry-user",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
	const decision = decideAutoResume({ ...decisionInput, marker });
	assert.equal(decision.resume, true);
});

test("the marker round-trips and never stores message content", () => {
	const configHome = scratch("gentle-retry-auto-resume-");
	writeAutoResumeMarker(configHome, { sessionId: "session-a", entryId: "entry-user" });
	const marker = readAutoResumeMarker(configHome);
	assert.equal(marker?.sessionId, "session-a");
	assert.equal(marker?.entryId, "entry-user");
	assert.equal(typeof marker?.updatedAt, "string");
	const raw = readFileSync(autoResumeMarkerPath(configHome), "utf8");
	assert.equal(raw.includes("keep going"), false);
});

test("an unreadable or foreign marker is ignored", () => {
	const configHome = scratch("gentle-retry-auto-resume-");
	assert.equal(readAutoResumeMarker(configHome), undefined);
	writeFileSync(autoResumeMarkerPath(configHome), "not json");
	assert.equal(readAutoResumeMarker(configHome), undefined);
	writeFileSync(autoResumeMarkerPath(configHome), JSON.stringify({ schema: "other/v1", sessionId: "a", entryId: "b", updatedAt: "c" }));
	assert.equal(readAutoResumeMarker(configHome), undefined);
});
