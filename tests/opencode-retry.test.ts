import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	OpenCodeRetryEvent,
	OpenCodeRetryPolicy,
} from "../src/opencode-retry.ts";

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

const {
	decideOpenCodeRetry,
	createOpenCodeRetryState,
	normalizeOpenCodeError,
	resolveOpenCodeRetryPolicy,
} = await import("../src/opencode-retry.ts");

const POLICY: OpenCodeRetryPolicy = {
	policy: "on",
	baseDelayMs: 100,
	maxDelayMs: 5_000,
};

function retryEvent(overrides: Partial<OpenCodeRetryEvent> = {}): OpenCodeRetryEvent {
	return {
		sessionID: "ses_one",
		attempt: 1,
		error: {
			type: "provider.error",
			message: "temporary failure",
		},
		decision: { retry: false },
		...overrides,
	};
}

function withConfigHome<T>(run: (configHome: string) => T): T {
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	const configHome = mkdtempSync(join(tmpdir(), "gentle-retry-opencode-config-"));
	try {
		process.env.GENTLE_PI_CONFIG_HOME = configHome;
		return run(configHome);
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
		rmSync(configHome, { recursive: true, force: true });
	}
}

function writeProjectPolicy(projectDir: string, content: unknown): void {
	const path = join(projectDir, ".pi", "gentle-ai", "retry-policy.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

test("normalizes OpenCode status, message, and response body without losing the safety error", () => {
	const normalized = normalizeOpenCodeError({
		type: "provider.error",
		message: "503: Service Unavailable",
		status: 503,
		response: { body: '{"message":"content safety screening is temporarily unavailable"}' },
	});
	assert.match(normalized, /503/);
	assert.match(normalized, /content safety screening is temporarily unavailable/);
});

test("retries the exact direct and wrapped content-safety screening failures", () => {
	const cases = [
		'Error: 503: {"message":"content safety screening is temporarily unavailable"}',
		'Error: Retry failed after 3 attempts: 503: {"message":"content safety screening is temporarily unavailable"}',
	];
	for (const message of cases) {
		const outcome = decideOpenCodeRetry({
			event: retryEvent({
				error: {
					type: "provider.error",
					message,
					status: 503,
					response: { body: '{"message":"content safety screening is temporarily unavailable"}' },
				},
			}),
			policy: POLICY,
			state: createOpenCodeRetryState(),
			now: 1_000,
			random: () => 0,
		});
		assert.equal(outcome.reason, "transient", message);
		assert.equal(outcome.kind, "content_safety_screening", message);
		assert.deepEqual(outcome.decision, { retry: true, delay: 100 }, message);
	}
});

test("policy off leaves OpenCode's decision untouched", () => {
	const event = retryEvent({ decision: { retry: true, delay: 999 } });
	const outcome = decideOpenCodeRetry({
		event,
		policy: { ...POLICY, policy: "off" },
		state: { attempts: 4, firstFailureAt: 10 },
		now: 20,
	});
	assert.equal(outcome.reason, "disabled");
	assert.deepEqual(outcome.decision, { retry: true, delay: 999 });
});

test("policy on vetoes recognized permanent failures", () => {
	const outcome = decideOpenCodeRetry({
		event: retryEvent({
			error: { type: "provider.auth", message: "authentication failed" },
			decision: { retry: true, delay: 50 },
		}),
		policy: POLICY,
		state: createOpenCodeRetryState(),
		now: 1_000,
	});
	assert.equal(outcome.reason, "permanent");
	assert.deepEqual(outcome.decision, { retry: false });
});

test("policy on preserves OpenCode's native decision for unknown failures", () => {
	const outcome = decideOpenCodeRetry({
		event: retryEvent({
			error: { type: "provider.unknown", message: "provider-specific unknown failure" },
			decision: { retry: true, delay: 777 },
		}),
		policy: POLICY,
		state: createOpenCodeRetryState(),
		now: 1_000,
	});
	assert.equal(outcome.reason, "unknown");
	assert.deepEqual(outcome.decision, { retry: true, delay: 777 });
});

test("honors structured and textual Retry-After guidance and caps it", () => {
	const structured = decideOpenCodeRetry({
		event: retryEvent({
			error: {
				type: "provider.error",
				message: "429 Too Many Requests",
				retryAfterMs: 12_000,
			},
		}),
		policy: { ...POLICY, maxDelayMs: 5_000 },
		state: createOpenCodeRetryState(),
		now: 1_000,
	});
	assert.deepEqual(structured.decision, { retry: true, delay: 5_000 });

	const textual = decideOpenCodeRetry({
		event: retryEvent({
			error: { type: "provider.error", message: "429 Too Many Requests; Retry-After: 2" },
		}),
		policy: POLICY,
		state: createOpenCodeRetryState(),
		now: 1_000,
	});
	assert.deepEqual(textual.decision, { retry: true, delay: 2_000 });
});

test("enforces maximum attempts and elapsed time per retry sequence", () => {
	const attempts = decideOpenCodeRetry({
		event: retryEvent({ error: { type: "provider.error", message: "429 Too Many Requests" } }),
		policy: { ...POLICY, maxAttempts: 1 },
		state: { attempts: 1, firstFailureAt: 1_000 },
		now: 1_010,
	});
	assert.equal(attempts.reason, "max_attempts");
	assert.deepEqual(attempts.decision, { retry: false });

	const elapsed = decideOpenCodeRetry({
		event: retryEvent({ error: { type: "provider.error", message: "429 Too Many Requests" } }),
		policy: { ...POLICY, maxElapsedMs: 1_000 },
		state: { attempts: 0, firstFailureAt: 1_000 },
		now: 2_000,
	});
	assert.equal(elapsed.reason, "max_elapsed");
	assert.deepEqual(elapsed.decision, { retry: false });
});

test("resolves the shared project policy and accepts strict plugin option overrides", () => {
	withConfigHome(() => {
		const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-opencode-project-"));
		try {
			writeProjectPolicy(projectDir, {
				schema: "gentle-pi.retry/v1",
				policy: "off",
				baseDelayMs: 250,
				maxDelayMs: 2_000,
			});
			const fromFile = resolveOpenCodeRetryPolicy(projectDir, {});
			assert.equal(fromFile.policy, "off");
			assert.equal(fromFile.baseDelayMs, 250);

			const overridden = resolveOpenCodeRetryPolicy(projectDir, {
				policy: "on",
				baseDelayMs: 300,
				maxDelayMs: 3_000,
				maxAttempts: 5,
			});
			assert.equal(overridden.policy, "on");
			assert.equal(overridden.baseDelayMs, 300);
			assert.equal(overridden.maxDelayMs, 3_000);
			assert.equal(overridden.maxAttempts, 5);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});

test("invalid or unknown plugin options fail closed to off", () => {
	withConfigHome(() => {
		const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-opencode-project-"));
		try {
			assert.equal(resolveOpenCodeRetryPolicy(projectDir, { policy: "on", typo: true }).policy, "off");
			assert.equal(resolveOpenCodeRetryPolicy(projectDir, { policy: "on", baseDelayMs: 0 }).policy, "off");
			assert.equal(resolveOpenCodeRetryPolicy(projectDir, { policy: "on", maxDelayMs: 10, baseDelayMs: 20 }).policy, "off");
			assert.equal(resolveOpenCodeRetryPolicy(projectDir, { policy: "on", maxAttempts: 0 }).policy, "off");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});

test("a malformed shared project policy still fails closed", () => {
	withConfigHome(() => {
		const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-opencode-project-"));
		try {
			writeProjectPolicy(projectDir, "{ invalid }");
			const resolved = resolveOpenCodeRetryPolicy(projectDir, { policy: "on" });
			assert.equal(resolved.policy, "off");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
