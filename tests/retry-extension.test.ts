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
const { default: gentleRetryExtension, createGentleRetryExtension, resetExtensionState } = extensionModule;
const { writeRetryPolicy } = policyModule;

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
	let sessionId = "test-session";
	const controller = new AbortController();
	const ctx = {
		cwd: projectDir,
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
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
		handlers,
		get sessionId() { return sessionId; },
		set sessionId(value: string) { sessionId = value; },
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
	assert.equal(h.notices.at(-1), "Use /gentle:retry enable|disable|status. State unchanged.");
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /ON/);
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
