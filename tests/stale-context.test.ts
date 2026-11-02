import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleRetryExtension, resetExtensionState } from "../dist/extension.js";
import { guardExtensionEvents, isStaleExtensionContext } from "../dist/stale-context.js";

// Pi's own wording for an invalidated session context.
const STALE_MESSAGE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakeApi(): { pi: ExtensionAPI; handlers: Map<string, EventHandler[]> } {
	const handlers = new Map<string, EventHandler[]>();
	const pi = {
		on(name: string, fn: EventHandler) {
			const list = handlers.get(name) ?? [];
			list.push(fn);
			handlers.set(name, list);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

/** Every read on Pi's replaced session context throws. */
function staleContext(): ExtensionContext {
	return new Proxy({}, { get() { throw new Error(STALE_MESSAGE); } }) as unknown as ExtensionContext;
}

test("a replaced session's context is recognized as stale", () => {
	assert.equal(isStaleExtensionContext({ mode: "tui" } as unknown as ExtensionContext), false);
	assert.equal(isStaleExtensionContext(staleContext()), true);
});

test("a synchronous handler keeps its synchronous return value", () => {
	const { pi, handlers } = fakeApi();
	guardExtensionEvents(pi);
	pi.on("input", () => ({ action: "transform", images: [] }));
	const result = (handlers.get("input") ?? [])[0]!({}, { mode: "tui" } as unknown as ExtensionContext);
	assert.deepEqual(result, { action: "transform", images: [] });
	assert.equal(result instanceof Promise, false, "the guard stays synchronous");
});

test("the guard keeps the API object identity", () => {
	const { pi } = fakeApi();
	assert.equal(guardExtensionEvents(pi), pi, "shared state keyed by the API object must not split");
	assert.equal(guardExtensionEvents(pi), pi, "guarding twice is a no-op");
});

test("a replaced session never reaches the retry handlers", async () => {
	resetExtensionState();
	const { pi, handlers } = fakeApi();
	createGentleRetryExtension()(pi);
	const ctx = staleContext();
	for (const handler of handlers.get("turn_end") ?? []) {
		await handler({ outcome: "error", message: { role: "assistant", errorMessage: "429 rate limit" } }, ctx);
	}
	for (const handler of handlers.get("agent_before_settle") ?? []) {
		await handler({ outcome: "error", entries: [], context: { contextEntries: [] } }, ctx);
	}
});

// The reported symptom: Pi dispatches an event from a session that was already
// replaced, and every context read on it throws.
test("a replaced session reports no extension error", async () => {
	resetExtensionState();
	const runtime = createExtensionRuntime();
	const extension = { path: "<test>/extension.js", handlers: new Map<string, EventHandler[]>() };
	const runner = new ExtensionRunner(
		[extension] as never,
		runtime,
		"/tmp",
		{ getSessionId: () => "session" } as never,
		{} as never,
	);
	const errors: { extensionPath: string; error: string }[] = [];
	runner.onError((error) => errors.push(error));
	const pi = {
		on(name: string, fn: EventHandler) {
			const list = extension.handlers.get(name) ?? [];
			list.push(fn);
			extension.handlers.set(name, list);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	createGentleRetryExtension()(pi);
	runner.invalidate();
	await runner.emit({ type: "agent_settled", aborted: false });
	assert.deepEqual(errors, [], "the replaced session must not report an extension error");
});
