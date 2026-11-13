import {
	classifyPermanentFailure,
	classifyTransientFailure,
	parseRetryAfterMs,
	type TransientFailureKind,
} from "./retry-classification.js";
import { retryDelayMs } from "./retry-backoff.js";
import {
	resolveRetryPolicy,
	type RetryPolicyValue,
} from "./retry-policy.js";

export interface OpenCodeRetryError {
	readonly type: string;
	readonly message: string;
	readonly status?: number;
	readonly response?: { readonly body?: string };
	readonly retryAfterMs?: number;
}

export type OpenCodeRetryDecision =
	| { readonly retry: false }
	| { readonly retry: true; readonly delay: number };

export interface OpenCodeRetryEvent {
	readonly sessionID: string;
	readonly attempt: number;
	readonly error: OpenCodeRetryError;
	decision: OpenCodeRetryDecision;
}

export interface OpenCodeRetryPolicy {
	policy: RetryPolicyValue;
	baseDelayMs: number;
	maxDelayMs: number;
	maxAttempts?: number;
	maxElapsedMs?: number;
}

export interface OpenCodeRetryState {
	attempts: number;
	firstFailureAt?: number;
}

export type OpenCodeRetryReason =
	| "disabled"
	| "transient"
	| "permanent"
	| "unknown"
	| "max_attempts"
	| "max_elapsed";

export interface OpenCodeRetryOutcome {
	decision: OpenCodeRetryDecision;
	state: OpenCodeRetryState;
	reason: OpenCodeRetryReason;
	kind?: TransientFailureKind;
	delayMs?: number;
}

export interface OpenCodeRetryOptions {
	policy?: RetryPolicyValue;
	baseDelayMs?: number;
	maxDelayMs?: number;
	maxAttempts?: number;
	maxElapsedMs?: number;
}

const OPTION_KEYS = new Set([
	"policy",
	"baseDelayMs",
	"maxDelayMs",
	"maxAttempts",
	"maxElapsedMs",
]);

export function createOpenCodeRetryState(): OpenCodeRetryState {
	return { attempts: 0 };
}

export function normalizeOpenCodeError(error: OpenCodeRetryError): string {
	const message = typeof error.message === "string" ? error.message.trim() : "";
	const status = typeof error.status === "number" ? `HTTP ${error.status}` : "";
	const body = typeof error.response?.body === "string" ? error.response.body.trim() : "";
	const parts: string[] = [];
	if (status && !message.includes(String(error.status))) parts.push(status);
	if (message) parts.push(message);
	if (body && !message.includes(body)) parts.push(body);
	return parts.join(": ");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function invalidPolicy(base: OpenCodeRetryPolicy): OpenCodeRetryPolicy {
	return {
		policy: "off",
		baseDelayMs: base.baseDelayMs,
		maxDelayMs: base.maxDelayMs,
		maxAttempts: base.maxAttempts,
		maxElapsedMs: base.maxElapsedMs,
	};
}

export function resolveOpenCodeRetryPolicy(
	cwd: string,
	options?: unknown,
): OpenCodeRetryPolicy {
	const shared = resolveRetryPolicy(cwd);
	const base: OpenCodeRetryPolicy = {
		policy: shared.policy,
		baseDelayMs: shared.baseDelayMs,
		maxDelayMs: shared.maxDelayMs,
		maxAttempts: shared.maxAttempts,
		maxElapsedMs: shared.maxElapsedMs,
	};
	if (shared.malformed) return invalidPolicy(base);
	if (options === undefined || options === null) return base;
	if (typeof options !== "object" || Array.isArray(options)) return invalidPolicy(base);

	const candidate = options as Record<string, unknown>;
	if (Object.keys(candidate).some((key) => !OPTION_KEYS.has(key))) return invalidPolicy(base);

	const policy = candidate.policy ?? shared.policy;
	const baseDelayMs = candidate.baseDelayMs ?? shared.baseDelayMs;
	const maxDelayMs = candidate.maxDelayMs ?? shared.maxDelayMs;
	const maxAttempts = candidate.maxAttempts ?? shared.maxAttempts;
	const maxElapsedMs = candidate.maxElapsedMs ?? shared.maxElapsedMs;
	if (policy !== "on" && policy !== "off") return invalidPolicy(base);
	if (!isPositiveInteger(baseDelayMs) || !isPositiveInteger(maxDelayMs)) return invalidPolicy(base);
	if (maxDelayMs < baseDelayMs) return invalidPolicy(base);
	if (maxAttempts !== undefined && !isPositiveInteger(maxAttempts)) return invalidPolicy(base);
	if (maxElapsedMs !== undefined && !isPositiveInteger(maxElapsedMs)) return invalidPolicy(base);
	return {
		policy,
		baseDelayMs,
		maxDelayMs,
		maxAttempts,
		maxElapsedMs,
	};
}

export function decideOpenCodeRetry(input: {
	event: OpenCodeRetryEvent;
	policy: OpenCodeRetryPolicy;
	state: OpenCodeRetryState;
	now?: number;
	random?: () => number;
}): OpenCodeRetryOutcome {
	const { event, policy, state } = input;
	const now = input.now ?? Date.now();
	if (policy.policy !== "on") {
		return {
			decision: event.decision,
			state: createOpenCodeRetryState(),
			reason: "disabled",
		};
	}

	const errorMessage = normalizeOpenCodeError(event.error);
	const kind = classifyTransientFailure(errorMessage);
	if (!kind) {
		const permanent = classifyPermanentFailure(errorMessage) !== undefined;
		return {
			decision: permanent ? { retry: false } : event.decision,
			state: createOpenCodeRetryState(),
			reason: permanent ? "permanent" : "unknown",
		};
	}

	const attempts = state.attempts + 1;
	const firstFailureAt = state.firstFailureAt ?? now;
	const nextState: OpenCodeRetryState = { attempts, firstFailureAt };
	if (policy.maxAttempts !== undefined && attempts > policy.maxAttempts) {
		return {
			decision: { retry: false },
			state: nextState,
			reason: "max_attempts",
			kind,
		};
	}
	const elapsedMs = Math.max(0, now - firstFailureAt);
	if (policy.maxElapsedMs !== undefined && elapsedMs >= policy.maxElapsedMs) {
		return {
			decision: { retry: false },
			state: nextState,
			reason: "max_elapsed",
			kind,
		};
	}

	const retryAfterMs = event.error.retryAfterMs ?? parseRetryAfterMs(errorMessage);
	const delayMs = retryAfterMs === undefined
		? retryDelayMs(attempts, policy.baseDelayMs, policy.maxDelayMs, input.random)
		: Math.min(Math.max(0, retryAfterMs), policy.maxDelayMs);
	return {
		decision: { retry: true, delay: delayMs },
		state: nextState,
		reason: "transient",
		kind,
		delayMs,
	};
}
