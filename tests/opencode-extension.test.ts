import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	OpenCodePluginContext,
	OpenCodeRetryEvent,
} from "../src/opencode.ts";

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

const { default: gentleRetryOpenCodePlugin } = await import("../src/opencode.ts");

interface QueuedEvent {
	type: string;
	data: { sessionID: string };
}

function createEventStream() {
	const queue: QueuedEvent[] = [];
	let wake: (() => void) | undefined;
	let signal: AbortSignal | undefined;
	return {
		push(event: QueuedEvent): void {
			queue.push(event);
			wake?.();
			wake = undefined;
		},
		get aborted(): boolean {
			return signal?.aborted === true;
		},
		async *subscribe(options?: { types?: readonly string[]; signal?: AbortSignal }): AsyncIterable<QueuedEvent> {
			signal = options?.signal;
			while (!signal?.aborted) {
				const event = queue.shift();
				if (event) {
					yield event;
					continue;
				}
				await new Promise<void>((resolve) => {
					const finish = () => {
						signal?.removeEventListener("abort", finish);
						resolve();
					};
					wake = finish;
					signal?.addEventListener("abort", finish, { once: true });
				});
			}
		},
	};
}

function writePolicy(projectDir: string, policy: Record<string, unknown>): void {
	const path = join(projectDir, ".pi", "gentle-ai", "retry-policy.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({
		schema: "gentle-pi.retry/v1",
		policy: "on",
		baseDelayMs: 1,
		maxDelayMs: 2,
		...policy,
	}));
}

function contentSafetyEvent(sessionID: string): OpenCodeRetryEvent {
	return {
		sessionID,
		attempt: 1,
		error: {
			type: "provider.error",
			message: 'Error: 503: {"message":"content safety screening is temporarily unavailable"}',
			status: 503,
			response: { body: '{"message":"content safety screening is temporarily unavailable"}' },
		},
		decision: { retry: false },
	};
}

async function harness(options?: { policy?: Record<string, unknown>; pluginOptions?: unknown }) {
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-opencode-plugin-"));
	const configHome = mkdtempSync(join(tmpdir(), "gentle-retry-opencode-config-"));
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writePolicy(projectDir, options?.policy ?? {});
	const events = createEventStream();
	let retryHook: ((event: OpenCodeRetryEvent) => void | Promise<void>) | undefined;
	let disposed = 0;
	const context = {
		location: { directory: projectDir },
		options: options?.pluginOptions,
		session: {
			hook: async (name: string, callback: (event: OpenCodeRetryEvent) => void | Promise<void>) => {
				assert.equal(name, "retry");
				retryHook = callback;
				return { dispose: () => { disposed += 1; } };
			},
		},
		event: { subscribe: events.subscribe },
	} as unknown as OpenCodePluginContext;
	const cleanup = await gentleRetryOpenCodePlugin.setup(context);
	return {
		events,
		projectDir,
		get disposed() { return disposed; },
		get aborted() { return events.aborted; },
		async retry(event: OpenCodeRetryEvent): Promise<void> {
			assert.ok(retryHook, "expected the retry hook to be registered");
			await retryHook(event);
		},
		async cleanup(): Promise<void> {
			await cleanup?.();
			if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
			else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
			rmSync(projectDir, { recursive: true, force: true });
			rmSync(configHome, { recursive: true, force: true });
		},
	};
}

test("registers the OpenCode retry hook and retries the content-safety 503", async () => {
	const h = await harness();
	try {
		const event = contentSafetyEvent("ses_one");
		await h.retry(event);
		assert.deepEqual(event.decision, { retry: true, delay: 1 });
	} finally {
		await h.cleanup();
	}
});

test("keeps retry limits isolated by OpenCode session", async () => {
	const h = await harness({ policy: { maxAttempts: 1 } });
	try {
		const first = contentSafetyEvent("ses_one");
		await h.retry(first);
		assert.equal(first.decision.retry, true);

		const second = contentSafetyEvent("ses_one");
		await h.retry(second);
		assert.equal(second.decision.retry, false);

		const otherSession = contentSafetyEvent("ses_two");
		await h.retry(otherSession);
		assert.equal(otherSession.decision.retry, true);
	} finally {
		await h.cleanup();
	}
});

test("resets retry state after successful and interrupted executions", async () => {
	const h = await harness({ policy: { maxAttempts: 1 } });
	try {
		const first = contentSafetyEvent("ses_one");
		await h.retry(first);
		const blocked = contentSafetyEvent("ses_one");
		await h.retry(blocked);
		assert.equal(blocked.decision.retry, false);

		h.events.push({ type: "session.execution.succeeded", data: { sessionID: "ses_one" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const afterSuccess = contentSafetyEvent("ses_one");
		await h.retry(afterSuccess);
		assert.equal(afterSuccess.decision.retry, true);

		const blockedAgain = contentSafetyEvent("ses_one");
		await h.retry(blockedAgain);
		assert.equal(blockedAgain.decision.retry, false);
		h.events.push({ type: "session.execution.interrupted", data: { sessionID: "ses_one" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const afterInterrupt = contentSafetyEvent("ses_one");
		await h.retry(afterInterrupt);
		assert.equal(afterInterrupt.decision.retry, true);
	} finally {
		await h.cleanup();
	}
});

test("plugin options can enable a project whose shared policy is off", async () => {
	const h = await harness({
		policy: { policy: "off" },
		pluginOptions: { policy: "on", baseDelayMs: 3, maxDelayMs: 4 },
	});
	try {
		const event = contentSafetyEvent("ses_one");
		await h.retry(event);
		assert.deepEqual(event.decision, { retry: true, delay: 3 });
	} finally {
		await h.cleanup();
	}
});

test("cleanup aborts the completion subscription and disposes the retry hook", async () => {
	const h = await harness();
	await h.cleanup();
	assert.equal(h.aborted, true);
	assert.equal(h.disposed, 1);
});
