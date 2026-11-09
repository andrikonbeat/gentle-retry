import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const pendingResumeModule = await import("../src/pending-resume.ts");
const reconnectModule = await import("../src/reconnect.ts");
const autoResumeModule = await import("../src/auto-resume.ts");

const {
	createGentleRetryExtension,
	resetExtensionState,
	setConnectivityFetchForTesting,
} = extensionModule;
const { writeRetryPolicy } = policyModule;
const { readPendingResumes, writePendingResume } = pendingResumeModule;
const { RECONNECT_PROMPT } = reconnectModule;
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

interface SentMessage {
	text: string;
	options?: { deliverAs?: "steer" | "followUp" };
}

function harness() {
	resetExtensionState();
	const configHome = mkdtempSync(join(tmpdir(), "gentle-retry-reconnect-config-"));
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-reconnect-project-"));
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const notices: string[] = [];
	const sent: SentMessage[] = [];
	let sessionId = "test-session";
	let branch: unknown[] = [
		{ id: "entry-user", type: "message", message: USER("hello") },
	];
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
		sendUserMessage: (text: string, options?: { deliverAs?: "steer" | "followUp" }) => {
			sent.push({ text, options });
		},
		events: { emit() {}, on: () => () => {} },
		getActiveTools: () => [],
		getSettings: () => ({}),
	} as unknown as ExtensionAPI;
	createGentleRetryExtension()(pi);
	function cleanup() {
		controller.abort();
		resetExtensionState();
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

async function settle(h: ReturnType<typeof harness>, event: unknown) {
	let result: unknown;
	for (const fn of h.handlers.get("agent_before_settle") ?? []) result = await fn(event, h.ctx);
	return result;
}

async function startSession(h: ReturnType<typeof harness>, reason = "resume") {
	for (const fn of h.handlers.get("session_start") ?? []) {
		await fn({ type: "session_start", reason }, h.ctx);
	}
}

type Selector = (title: string, options: string[]) => Promise<string | undefined>;

function withSelector(h: ReturnType<typeof harness>, select: Selector) {
	const calls: Array<{ title: string; options: string[] }> = [];
	(h.ctx.ui as unknown as { select: Selector }).select = async (title: string, options: string[]) => {
		calls.push({ title, options });
		return select(title, options);
	};
	return calls;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for the test condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function withRandom<T>(value: number, run: () => T | Promise<T>): Promise<T> {
	const original = Math.random;
	Math.random = () => value;
	try {
		return await run();
	} finally {
		Math.random = original;
	}
}

test("reconnect is off by default and does not probe", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 1, maxDelayMs: 2 });
	let probes = 0;
	setConnectivityFetchForTesting(async () => {
		probes += 1;
		return { ok: true };
	});
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("Request timed out")] },
	]);

	const result = await withRandom(0, () => settle(h, event)) as { continue: boolean };
	assert.equal(result.continue, true);
	assert.equal(probes, 0);
	assert.deepEqual(h.notices, [
		"Retry 1 (timeout) — waiting 1ms… Press Esc to stop.",
		"Continuing after timeout (attempt 1)…",
	]);
	h.cleanup();
});

test("a healthy session does not probe", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { reconnect: "global" });
	let probes = 0;
	setConnectivityFetchForTesting(async () => {
		probes += 1;
		return { ok: true };
	});
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-success", messages: [ASSISTANT_OK()] },
	], "completed");

	const result = await settle(h, event);
	assert.equal(result, undefined);
	assert.equal(probes, 0);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("a provider timeout on a reachable machine follows today's retry path", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, {
		baseDelayMs: 1,
		maxDelayMs: 2,
		reconnect: "global",
	});
	let probes = 0;
	setConnectivityFetchForTesting(async () => {
		probes += 1;
		return { ok: true };
	});
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("Request timed out")] },
	]);

	const result = await withRandom(0, () => settle(h, event)) as { continue: boolean };
	assert.equal(result.continue, true);
	assert.equal(probes, 1);
	assert.deepEqual(h.notices, [
		"Retry 1 (timeout) — waiting 1ms… Press Esc to stop.",
		"Continuing after timeout (attempt 1)…",
	]);
	h.cleanup();
});

test("an offline failure waits without consuming an attempt and continues the same turn", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, {
		baseDelayMs: 1,
		maxDelayMs: 2,
		reconnect: "global",
	});
	let probes = 0;
	setConnectivityFetchForTesting(async () => {
		probes += 1;
		if (probes <= 2) throw new Error("offline");
		return { ok: true };
	});
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("Request timed out")] },
	]);

	const result = await settle(h, event) as { continue: boolean };
	assert.equal(result.continue, true);
	assert.equal(probes, 3);
	assert.match(h.notices[0]!, /Waiting for the network to come back/);
	assert.match(h.notices[1]!, /Continuing after the network outage/);
	assert.equal(h.notices.some((notice) => notice.startsWith("Retry ")), false);

	// The reconnect continuation did not consume provider attempt 1.
	h.notices.length = 0;
	const next = await withRandom(0, () => settle(h, event)) as { continue: boolean };
	assert.equal(next.continue, true);
	assert.match(h.notices[0]!, /^Retry 1 /);
	h.cleanup();
});

test("a non-classifiable failure waits while offline and then continues the turn", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { reconnect: "global" });
	let probes = 0;
	setConnectivityFetchForTesting(async () => {
		probes += 1;
		if (probes <= 2) throw new Error("offline");
		return { ok: true };
	});
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("service unavailable")] },
	]);

	const result = await settle(h, event) as { continue: boolean };
	assert.equal(result.continue, true);
	assert.equal(probes, 3);
	assert.match(h.notices[0]!, /Waiting for the network to come back/);
	assert.equal(h.notices.some((notice) => notice.startsWith("Retry ")), false);
	h.cleanup();
});

test("the offline wait is visible and Escape cancels it", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { reconnect: "global" });
	setConnectivityFetchForTesting(async () => {
		throw new Error("offline");
	});
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("Request timed out")] },
	]);

	const pending = settle(h, event);
	await new Promise((resolve) => setTimeout(resolve, 20));
	h.controller.abort();
	const result = await pending;
	assert.equal(result, undefined);
	assert.match(h.notices[0]!, /Waiting for the network to come back.*Press Esc to stop/);
	assert.equal(h.notices.some((notice) => notice.startsWith("Continuing after the network outage")), false);
	h.cleanup();
});

test("a permanent quota failure never waits", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { reconnect: "global" });
	let probes = 0;
	setConnectivityFetchForTesting(async () => {
		probes += 1;
		return { ok: true };
	});
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("insufficient quota")] },
	]);

	const result = await settle(h, event);
	assert.equal(result, undefined);
	assert.equal(probes, 1);
	assert.equal(h.notices.length, 0);
	h.cleanup();
});

test("after an offline turn ends, reconnect sends the continuation once and records it", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { reconnect: "global" });
	const originalDateNow = Date.now;
	let fakeNow = originalDateNow();
	let probes = 0;
	setConnectivityFetchForTesting(async () => {
		probes += 1;
		if (probes <= 3) {
			if (probes === 3) fakeNow += 300_001;
			throw new Error("offline");
		}
		return { ok: true };
	});
	Date.now = () => fakeNow;
	try {
		const event = settleEvent([
			{ id: "entry-user", messages: [USER("hello")] },
			{ id: "entry-assistant", messages: [ASSISTANT_ERROR("service unavailable")] },
		]);
		const result = await settle(h, event);
		assert.equal(result, undefined);
		await waitFor(() => h.sent.length === 1 && readPendingResumes(h.configHome).length === 1);
	} finally {
		Date.now = originalDateNow;
	}

	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0]!.text, RECONNECT_PROMPT);
	assert.deepEqual(h.sent[0]!.options, { deliverAs: "followUp" });
	const records = readPendingResumes(h.configHome);
	assert.equal(records.length, 1);
	assert.equal(records[0]!.sessionId, h.sessionId);
	assert.equal(records[0]!.entryId, "entry-user");
	assert.equal(records[0]!.reason, "reconnect");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(h.sent.length, 1);
	h.cleanup();
});

test("auto-resume skips a turn already covered by the shared pending record", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { autoResume: true });
	writePendingResume(h.configHome, {
		sessionId: h.sessionId,
		entryId: "entry-user",
		reason: "reconnect",
	});

	await startSession(h);
	assert.equal(h.sent.length, 0);
	h.cleanup();
});

test("auto-resume writes the shared pending record after sending", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { autoResume: true });

	await startSession(h);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0]!.text, AUTO_RESUME_PROMPT);
	const records = readPendingResumes(h.configHome);
	assert.equal(records.length, 1);
	assert.equal(records[0]!.reason, "auto-resume");
	h.cleanup();
});

test("the menu exposes the reconnect actions and the session opt-in", async () => {
	const h = harness();
	const calls = withSelector(h, () => undefined);
	await h.commands.get("gentle:retry")!.handler("", h.ctx);
	assert.equal(calls[0]!.title, "Gentle retry (current: off)");
	for (const expected of [
		"Reconnect: global (every open session)",
		"Reconnect: session (opt-in per session)",
		"Reconnect: off (this project)",
		"Reconnect for this session: on",
	]) {
		assert.ok(calls[0]!.options.includes(expected), `the menu must offer "${expected}"`);
	}

	await h.commands.get("gentle:retry")!.handler("reconnect enable", h.ctx);
	await h.commands.get("gentle:retry")!.handler("", h.ctx);
	assert.ok(calls[1]!.options.includes("Reconnect for this session: off"));
	h.cleanup();
});

test("reconnect commands write the project and global scopes to the right files", async () => {
	const h = harness();
	const projectPolicy = join(h.projectDir, ".pi", "gentle-ai", "retry-policy.json");
	const globalPolicy = join(h.configHome, "retry-policy.json");

	await h.commands.get("gentle:retry")!.handler("reconnect session", h.ctx);
	assert.equal(JSON.parse(readFileSync(projectPolicy, "utf8")).reconnect, "session");
	assert.equal(existsSync(globalPolicy), false);

	await h.commands.get("gentle:retry")!.handler("reconnect global", h.ctx);
	assert.equal(JSON.parse(readFileSync(globalPolicy, "utf8")).reconnect, "global");
	assert.equal(JSON.parse(readFileSync(projectPolicy, "utf8")).reconnect, "session");

	await h.commands.get("gentle:retry")!.handler("reconnect off", h.ctx);
	assert.equal(JSON.parse(readFileSync(projectPolicy, "utf8")).reconnect, "off");

	await h.commands.get("gentle:retry")!.handler("reconnect enable", h.ctx);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /reconnect: off/);
	assert.match(h.notices.at(-1)!, /reconnect session opt-in: yes/);
	await h.commands.get("gentle:retry")!.handler("doctor", h.ctx);
	assert.match(h.notices.at(-1)!, /reconnect: off/);
	assert.match(h.notices.at(-1)!, /reconnect session opt-in: yes/);

	await h.commands.get("gentle:retry")!.handler("reconnect disable", h.ctx);
	await h.commands.get("gentle:retry")!.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /reconnect session opt-in: no/);
	h.cleanup();
});

test("session scope participates only after the session opts in", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { baseDelayMs: 1, maxDelayMs: 2, reconnect: "session" });
	let probes = 0;
	setConnectivityFetchForTesting(async () => {
		probes += 1;
		return { ok: true };
	});
	const event = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("Request timed out")] },
	]);

	await withRandom(0, () => settle(h, event));
	assert.equal(probes, 0);

	await h.commands.get("gentle:retry")!.handler("reconnect enable", h.ctx);
	h.notices.length = 0;
	await withRandom(0, () => settle(h, event));
	assert.equal(probes, 1);
	h.cleanup();
});

test("the reconnect budget stops after three resumes and resets on a successful turn", async () => {
	const h = harness();
	writeRetryPolicy("on", h.projectDir, { reconnect: "global" });
	const outcomes = [
		false, false, true,
		false, false, true,
		false, false, true,
		false, false,
		false, true,
	];
	let outcomeIndex = 0;
	setConnectivityFetchForTesting(async () => {
		const online = outcomes[outcomeIndex++] ?? true;
		if (!online) throw new Error("offline");
		return { ok: true };
	});
	const failed = settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-assistant", messages: [ASSISTANT_ERROR("service unavailable")] },
	]);

	for (let resume = 0; resume < 3; resume += 1) {
		const result = await settle(h, failed) as { continue: boolean };
		assert.equal(result.continue, true);
	}
	assert.equal(h.notices.filter((notice) => notice.startsWith("Waiting for the network")).length, 3);

	const exhausted = await settle(h, failed);
	assert.equal(exhausted, undefined);
	assert.equal(h.notices.filter((notice) => notice.startsWith("Waiting for the network")).length, 3);

	await settle(h, settleEvent([
		{ id: "entry-user", messages: [USER("hello")] },
		{ id: "entry-success", messages: [ASSISTANT_OK()] },
	], "completed"));
	const afterSuccess = await settle(h, failed) as { continue: boolean };
	assert.equal(afterSuccess.continue, true);
	assert.equal(h.notices.filter((notice) => notice.startsWith("Waiting for the network")).length, 4);
	h.cleanup();
});
