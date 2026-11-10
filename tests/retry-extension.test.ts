import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The focused verification command does not build first. Resolve the source
// module's emitted-style `.js` imports back to their TypeScript sources.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
			const url = new URL(specifier, context.parentURL);
			url.pathname = `${url.pathname.slice(0, -3)}.ts`;
			return { url: url.href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

const extensionModule = await import("../src/extension.ts");
const policyModule = await import("../src/retry-policy.ts");
const autoResumeModule = await import("../src/auto-resume.ts");
const { default: gentleRetryExtension, createGentleRetryExtension, resetExtensionState } = extensionModule;
const { writeRetryPolicy } = policyModule;
const { AUTO_RESUME_PROMPT } = autoResumeModule;

const USER = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

const ASSISTANT_ERROR = (errorMessage: string) => ({
	role: "assistant",
	content: [],
	stopReason: "error",
	errorMessage,
	timestamp: 0,
});

const ASSISTANT_OK = () => ({
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	stopReason: "stop",
	timestamp: 0,
});

const REQUESTED_TRANSIENT_MESSAGES = [
	"Error: Request timed out.",
	"Error: Connection error.",
	"Error: Retry failed after 3 attempts: Connection error.",
	'Error: 429 {"status":429,"title":"Too Many Requests"}',
	"Error: 502 <html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Gateway</h1></center> <hr><center>openresty</center> </body> </html>",
	"Error: Retry failed after 1 attempts: 400 {\"status\":400,\"title\":\"Bad Request\",\"detail\":\"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked\"}",
	"Error: 400 {\"status\":400,\"title\":\"Bad Request\",\"detail\":\"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked\"}",
	"Error: Stream ended without finish_reason",
];

/**
 * Builds the real `agent_before_settle` shape Pi emits: `context` is a
 * BoundaryContextPreview, and the failure text lives on the assistant message.
 */
function settleEvent(entries: Array<{ id: string; messages: unknown[] }>, outcome = "error") {
	const contextEntries = entries.map((entry) => ({
		sourceEntry: { id: entry.id, type: "message", timestamp: 0, parentId: null },
		messages: entry.messages,
	}));
	const messages = contextEntries.flatMap((entry) => entry.messages);
	return {
		type: "agent_before_settle",
		outcome,
		entries: [],
		continue: false,
		context: {
			contextEntries,
			contextMessages: messages,
			llmMessages: messages,
			pendingMessages: [],
			canContinue: true,
		},
	};
}

function harness() {
	resetExtensionState();
	const configHome = mkdtempSync(join(tmpdir(), "gentle-retry-config-"));
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-proj-"));
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const notices: string[] = [];
	const sent: string[] = [];
	let sessionId = "test-session";
	let branch: unknown[] = [];
	const controller = new AbortController();
	const ctx = {
		cwd: projectDir,
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
		ui: {
			notify: (text: string) => notices.push(text),
			setStatus: () => {},
			setWidget: () => {},
		},
		signal: controller.signal,
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, command),
		registerTool: () => {},
		registerMessageRenderer() {},
		registerFlag() {},
		sendUserMessage: (text: string) => {
			sent.push(text);
		},
		events: { emit() {}, on: () => () => {} },
		getActiveTools: () => [],
		getSettings: () => ({}),
	} as unknown as ExtensionAPI;
	createGentleRetryExtension()(pi);
	function cleanup() {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		try { rmSync(configHome, { recursive: true, force: true }); } catch {}
		try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
	}
	return {
		ctx,
		commands,
		notices,
		sent,
		handlers,
		get sessionId() { return sessionId; },
		set sessionId(value: string) { sessionId = value; },
		get branch() { return branch; },
		set branch(value: unknown[]) { branch = value; },
		configHome,
		projectDir,
		controller,
		cleanup,
	};
}

async function settle(h: ReturnType<typeof harness>, event: unknown, delayMs = 0) {
	if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
	let result: unknown;
	for (const fn of h.handlers.get("agent_before_settle") ?? []) result = await fn(event, h.ctx);
	return result;
}

/** Enables the extension with a millisecond policy so retry tests stay fast. */
async function enableFast(h: ReturnType<typeof harness>) {
	await h.commands.get("gentle:retry")!.handler("enable", h.ctx);
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 1, maxDelayMs: 2 });
	h.notices.length = 0;
}

test("the module default export is a valid Pi extension factory", () => {
	assert.equal(typeof gentleRetryExtension, "function");
});

test("command registers and reports status when off by default", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("", h.ctx);
	assert.match(h.notices.at(-1)!, /OFF/);
	h.cleanup();
});

test("enable/disable/status commands persist and report correctly", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("enable", h.ctx);
	assert.match(h.notices.at(-1)!, /enabled/);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /ON/);
	await h.commands.get("gentle:retry")!.handler("disable", h.ctx);
	assert.match(h.notices.at(-1)!, /disabled/);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /OFF/);
	h.cleanup();
});

test("invalid subcommand shows usage and leaves state unchanged", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("enable", h.ctx);
	await h.commands.get("gentle:retry")!.handler("invalid", h.ctx);
	assert.equal(
		h.notices.at(-1),
		"Use /gentle:retry enable [--global]|disable [--global]|status|pause|resume|auto-resume <on|off> [--global]|doctor. State unchanged.",
	);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /ON/);
	h.cleanup();
});

test("global enable and disable write the global policy without changing the project", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("enable --global", h.ctx);
	assert.match(h.notices.at(-1)!, /enabled \(global\)/);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /ON.*source: global_file/);

	await h.commands.get("gentle:retry")!.handler("disable --global", h.ctx);
	assert.match(h.notices.at(-1)!, /disabled \(global\)/);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /OFF.*source: global_file/);
	h.cleanup();
});

test("status reports effective source, delay bounds, optional limits, and pause state", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, {
		baseDelayMs: 1500,
		maxDelayMs: 45000,
		maxAttempts: 9,
		maxElapsedMs: 120000,
	});
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /ON/);
	assert.match(h.notices.at(-1)!, /source: project_file/);
	assert.match(h.notices.at(-1)!, /delays: 1500ms-45000ms/);
	assert.match(h.notices.at(-1)!, /max attempts: 9/);
	assert.match(h.notices.at(-1)!, /max elapsed: 120000ms/);
	assert.match(h.notices.at(-1)!, /paused: no/);
	h.cleanup();
});

test("pause is session-scoped, blocks retries, and resume restores them", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
	]);

	await h.commands.get("gentle:retry")!.handler("pause", h.ctx);
	assert.match(h.notices.at(-1)!, /paused for this session/);
	assert.equal(await settle(h, event), undefined);

	await h.commands.get("gentle:retry")!.handler("resume", h.ctx);
	assert.match(h.notices.at(-1)!, /resumed for this session/);
	assert.equal(((await settle(h, event)) as { continue: boolean }).continue, true);

	await h.commands.get("gentle:retry")!.handler("pause", h.ctx);
	h.sessionId = "another-session";
	assert.equal(((await settle(h, event)) as { continue: boolean }).continue, true);
	h.cleanup();
});

test("doctor reports actionable configuration and install diagnostics", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { maxAttempts: 4 });
	await h.commands.get("gentle:retry")!.handler("doctor", h.ctx);
	const diagnostic = h.notices.at(-1)!;
	assert.match(diagnostic, /gentle-retry doctor/);
	assert.match(diagnostic, /policy: ON/);
	assert.match(diagnostic, /source: project_file/);
	assert.match(diagnostic, /max attempts: 4/);
	assert.match(diagnostic, /project policy: .*retry-policy\.json/);
	assert.match(diagnostic, /global policy: .*retry-policy\.json/);
	assert.match(diagnostic, /config home:/);
	assert.match(diagnostic, /install: pi install npm:gentle-retry/);
	assert.doesNotMatch(diagnostic, /api[_-]?key|token|password|credential/i);
	h.cleanup();
});

test("optional max attempts stops the sequence and reports the limit", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1 });
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
	]);
	assert.equal(((await settle(h, event)) as { continue: boolean }).continue, true);
	assert.equal(await settle(h, event), undefined);
	assert.match(h.notices.at(-1)!, /maximum attempts reached \(1\)/);
	h.cleanup();
});

test("optional max elapsed time stops the sequence and reports the limit", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 1, maxDelayMs: 2, maxElapsedMs: 1 });
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
	]);
	assert.equal(((await settle(h, event)) as { continue: boolean }).continue, true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(await settle(h, event), undefined);
	assert.match(h.notices.at(-1)!, /maximum elapsed time reached \(1ms\)/);
	h.cleanup();
});

test("agent_before_settle retries a 429 and omits the failed assistant entry", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
	]);
	const result = (await settle(h, event)) as { entries: Array<{ type: string; targetId: string; replacement: unknown }>; continue: boolean };
	assert.match(h.notices[0]!, /Retry 1.*HTTP 429.*waiting/);
	assert.equal(result.continue, true);
	assert.equal(result.entries.length, 1);
	assert.equal(result.entries[0]!.type, "context_edit");
	assert.equal(result.entries[0]!.targetId, "entry-assistant");
	assert.equal(result.entries[0]!.replacement, null);
	assert.match(h.notices.at(-1)!, /Continuing after HTTP 429/);
	h.cleanup();
});

test("agent_before_settle retries a timeout", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("Request timed out")] },
	]);
	const result = (await settle(h, event)) as { continue: boolean };
	assert.match(h.notices.at(-1)!, /Continuing after timeout/);
	assert.equal(result.continue, true);
	h.cleanup();
});

test("agent_before_settle retries every exact requested transient failure", async () => {
	const h = harness();
	await enableFast(h);
	for (const message of REQUESTED_TRANSIENT_MESSAGES) {
		const event = settleEvent([
			{ id: "entry-user", messages: [USER("hello")] },
			{ id: "entry-assistant", messages: [ASSISTANT_ERROR(message)] },
		]);
		const result = (await settle(h, event)) as { continue: boolean };
		assert.equal(result.continue, true, message);
	}
	h.cleanup();
});

test("agent_before_settle never retries quota or auth failures", async () => {
	const h = harness();
	await enableFast(h);
	for (const message of ["insufficient quota", "authentication failed", "payment required"]) {
		const event = settleEvent([
			{ id: "entry-user", messages: [USER("hello")] },
			{ id: "entry-assistant", messages: [ASSISTANT_ERROR(message)] },
		]);
		const result = await settle(h, event);
		assert.equal(result, undefined);
	}
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("agent_before_settle never retries a generic HTTP 400 failure", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR('400 {"status":400,"title":"Bad Request","detail":"The request timed out"}')] },
	]);
	const result = await settle(h, event);
	assert.equal(result, undefined);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("agent_before_settle does nothing when the policy is off", async () => {
	const h = harness();
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429")] },
	]);
	const result = await settle(h, event);
	assert.equal(result, undefined);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("agent_before_settle does nothing after a completed turn", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent(
		[
			{ id: "entry-user", messages: [USER("hello")] },
			{ id: "entry-assistant", messages: [ASSISTANT_OK()] },
		],
		"completed",
	);
	const result = await settle(h, event);
	assert.equal(result, undefined);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("agent_before_settle never retries a completed boundary with an older failed entry", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent(
		[
			{ id: "entry-user", messages: [USER("hello")] },
			{ id: "entry-old-error", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
			{ id: "entry-success", messages: [ASSISTANT_OK()] },
		],
		"completed",
	);
	const result = await settle(h, event);
	assert.equal(result, undefined);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("agent_before_settle never retries an aborted boundary", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent(
		[
			{ id: "entry-user", messages: [USER("hello")] },
			{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
		],
		"aborted",
	);
	const result = await settle(h, event);
	assert.equal(result, undefined);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("agent_before_settle honors Retry-After and caps it at maxDelayMs", async () => {
	const h = harness();
	await enableFast(h);
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 1, maxDelayMs: 50 });
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests; Retry-After: 2")] },
	]);
	const result = (await settle(h, event)) as { continue: boolean };
	assert.match(h.notices[0]!, /waiting 50ms/);
	assert.equal(result.continue, true);
	h.cleanup();
});

test("agent_before_settle falls back to normal backoff for malformed Retry-After guidance", async () => {
	const h = harness();
	await enableFast(h);
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 1, maxDelayMs: 50 });
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests; Retry-After: invalid")] },
	]);
	const result = (await settle(h, event)) as { continue: boolean };
	assert.match(h.notices[0]!, /waiting [12]ms/);
	assert.equal(result.continue, true);
	h.cleanup();
});

test("backoff uses factor 1.8 with proportional jitter and remains capped", async () => {
	const h = harness();
	await enableFast(h);
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 100, maxDelayMs: 250 });
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
	]);
	const originalRandom = Math.random;
	Math.random = () => 1;
	try {
		await settle(h, event);
		await settle(h, event);
		await settle(h, event);
	} finally {
		Math.random = originalRandom;
	}
	const retryNotices = h.notices.filter((notice) => notice.startsWith("Retry "));
	assert.match(retryNotices[0]!, /waiting 110ms/);
	assert.match(retryNotices[1]!, /Retry 2.*waiting 198ms/);
	assert.match(retryNotices[2]!, /Retry 3.*waiting 250ms/);
	h.cleanup();
});

test("the wait is real and Escape aborts it", async () => {
	const h = harness();
	await enableFast(h);
	// write a slow policy directly so the wait is measurable
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 5_000, maxDelayMs: 60_000 });
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429")] },
	]);
	const started = Date.now();
	const pending = settle(h, event);
	await new Promise((resolve) => setTimeout(resolve, 50));
	h.controller.abort();
	const result = await pending;
	const elapsed = Date.now() - started;
	assert.equal(result, undefined);
	assert.ok(elapsed >= 40, `the handler must wait before continuing (waited ${elapsed}ms)`);
	assert.ok(elapsed < 2_000, "abort must cut the wait short");
	h.cleanup();
});

test("attempts grow across consecutive settle failures and reset per session", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429")] },
	]);
	await settle(h, event);
	assert.match(h.notices.at(-2)!, /Retry 1/);
	await settle(h, event);
	assert.match(h.notices.at(-2)!, /Retry 2/);
	h.sessionId = "another-session";
	await settle(h, event);
	assert.match(h.notices.at(-2)!, /Retry 1/);
	h.cleanup();
});

test("attempt counters reset after completed, aborted, non-transient, and policy-switch boundaries", async () => {
	const h = harness();
	await enableFast(h);
	const failed = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
	]);
	const retryNumbers = () => h.notices
		.filter((notice) => notice.startsWith("Retry "))
		.map((notice) => Number(notice.match(/^Retry (\d+)/)?.[1]));

	await settle(h, failed);
	assert.deepEqual(retryNumbers(), [1]);

	h.notices.length = 0;
	await settle(h, settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-old-error", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
	], "completed"));
	await settle(h, failed);
	assert.deepEqual(retryNumbers(), [1]);

	await settle(h, failed);
	assert.deepEqual(retryNumbers(), [1, 2]);

	h.notices.length = 0;
	await settle(h, settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429 Too Many Requests")] },
	], "aborted"));
	await settle(h, failed);
	assert.deepEqual(retryNumbers(), [1]);

	h.notices.length = 0;
	await settle(h, settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("model not found")] },
	]));
	await settle(h, failed);
	assert.deepEqual(retryNumbers(), [1]);

	h.notices.length = 0;
	await h.commands.get("gentle:retry")!.handler("disable", h.ctx);
	await h.commands.get("gentle:retry")!.handler("enable", h.ctx);
	await settle(h, failed);
	assert.deepEqual(retryNumbers(), [1]);
	h.cleanup();
});

test("agent_before_settle preserves entries proposed by other handlers", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("429")] },
	]);
	(event as { entries: unknown[] }).entries = [{ type: "custom", customType: "other", data: { keep: true } }];
	const result = (await settle(h, event)) as { entries: Array<{ type: string; targetId?: string }> };
	assert.equal(result.entries.length, 2);
	assert.equal(result.entries[0]!.type, "custom");
	assert.equal(result.entries[1]!.type, "context_edit");
	h.cleanup();
});

test("agent_before_settle does nothing when the failed assistant entry is missing", async () => {
	const h = harness();
	await enableFast(h);
	const event = settleEvent([{ id: "entry-user", messages: [USER("hello")] }]);
	const result = await settle(h, event);
	assert.equal(result, undefined);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

async function startSession(h: ReturnType<typeof harness>, ctx: ExtensionContext = h.ctx) {
	for (const fn of h.handlers.get("session_start") ?? []) await fn({ type: "session_start", reason: "startup" }, ctx);
}

test("session_start introduces the extension once and then stays silent", async () => {
	const h = harness();
	await startSession(h);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0]!, /\/gentle:retry enable/);
	await startSession(h);
	assert.equal(h.notices.length, 1);
	h.cleanup();
});

test("session_start stays silent without a UI so scripted modes are not polluted", async () => {
	const h = harness();
	await startSession(h, { ...h.ctx, hasUI: false, mode: "print" } as unknown as ExtensionContext);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("session_start stays silent when retry is already enabled", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("enable", h.ctx);
	h.notices.length = 0;
	await startSession(h);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

async function startSessionWithReason(
	h: ReturnType<typeof harness>,
	reason: string,
	ctx: ExtensionContext = h.ctx,
) {
	for (const fn of h.handlers.get("session_start") ?? []) await fn({ type: "session_start", reason }, ctx);
}

test("the status and the doctor report the auto-resume state", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /auto resume: OFF/);
	await h.commands.get("gentle:retry")!.handler("doctor", h.ctx);
	assert.match(h.notices.at(-1)!, /auto resume: OFF/);
	h.cleanup();
});

test("the auto-resume command persists the flag in the chosen scope only", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("auto-resume on", h.ctx);
	assert.match(h.notices.at(-1)!, /Auto-resume enabled \(project\)/);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /auto resume: ON/);
	await h.commands.get("gentle:retry")!.handler("auto-resume off --global", h.ctx);
	assert.match(h.notices.at(-1)!, /Auto-resume disabled \(global\)/);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /auto resume: ON/);
	h.cleanup();
});

test("an interrupted turn is continued once when auto-resume is enabled", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("auto-resume on", h.ctx);
	h.branch = [{ id: "entry-user", type: "message", message: USER("keep going") }];
	await startSessionWithReason(h, "resume");
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0], AUTO_RESUME_PROMPT);
	h.cleanup();
});

test("auto-resume does nothing while it is disabled", async () => {
	const h = harness();
	h.branch = [{ id: "entry-user", type: "message", message: USER("keep going") }];
	await startSessionWithReason(h, "resume");
	assert.equal(h.sent.length, 0);
	h.cleanup();
});

test("auto-resume ignores completed, aborted, and failed turns", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("auto-resume on", h.ctx);
	for (const stopReason of ["stop", "aborted", "error"]) {
		h.branch = [
			{ id: "entry-user", type: "message", message: USER("keep going") },
			{
				id: "entry-assistant",
				type: "message",
				message: { role: "assistant", content: [], stopReason, timestamp: 0 },
			},
		];
		await startSessionWithReason(h, "resume");
	}
	assert.equal(h.sent.length, 0);
	h.cleanup();
});

test("auto-resume never continues the same turn twice", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("auto-resume on", h.ctx);
	h.branch = [{ id: "entry-user", type: "message", message: USER("keep going") }];
	await startSessionWithReason(h, "resume");
	assert.equal(h.sent.length, 1);
	h.branch = [
		{ id: "entry-user", type: "message", message: USER("keep going") },
		{ id: "entry-continuation", type: "message", message: USER(AUTO_RESUME_PROMPT) },
	];
	await startSessionWithReason(h, "resume");
	assert.equal(h.sent.length, 1);
	h.cleanup();
});

test("auto-resume only runs for resumed sessions in an interactive terminal", async () => {
	const h = harness();
	await h.commands.get("gentle:retry")!.handler("auto-resume on", h.ctx);
	h.branch = [{ id: "entry-user", type: "message", message: USER("keep going") }];
	await startSessionWithReason(h, "new");
	await startSessionWithReason(h, "fork");
	await startSessionWithReason(h, "resume", { ...h.ctx, mode: "rpc" } as unknown as ExtensionContext);
	assert.equal(h.sent.length, 0);
	h.cleanup();
});

type Selector = (title: string, options: string[]) => Promise<string | undefined>;

function withSelector(h: ReturnType<typeof harness>, select: Selector) {
	const calls: Array<{ title: string; options: string[] }> = [];
	(h.ctx.ui as unknown as { select: Selector }).select = async (title: string, options: string[]) => {
		calls.push({ title, options });
		return select(title, options);
	};
	return calls;
}

test("the command without arguments opens the interactive menu", async () => {
	const h = harness();
	const calls = withSelector(h, (_title, options) => options.find((option) => option.startsWith("Auto-resume")));
	await h.commands.get("gentle:retry")!.handler("", h.ctx);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.title, "Gentle retry (current: off)");
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /auto resume: ON/);
	h.cleanup();
});

test("the menu offers every action of the command surface", async () => {
	const h = harness();
	const calls = withSelector(h, () => undefined);
	await h.commands.get("gentle:retry")!.handler("", h.ctx);
	const options = calls[0]!.options;
	for (const expected of [
		"Enable for this project",
		"Disable for this project",
		"Enable for every project",
		"Disable for every project",
		"Pause retrying in this session",
		"Auto-resume: on",
		"Show status",
		"Show diagnostics",
	]) {
		assert.ok(options.includes(expected), `the menu must offer "${expected}"`);
	}
	h.cleanup();
});

test("cancelling the menu changes nothing", async () => {
	const h = harness();
	withSelector(h, () => undefined);
	await h.commands.get("gentle:retry")!.handler("", h.ctx);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /Transient provider retry OFF/);
	assert.match(h.notices.at(-1)!, /auto resume: OFF/);
	h.cleanup();
});
