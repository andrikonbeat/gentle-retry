import { hasPendingResume, type PendingResume } from "./pending-resume.js";

export const RECONNECT_PROMPT =
	"The network connection was restored. Continue from where you left off without repeating completed work.";

export type ReconnectScope = "off" | "session" | "global";

export const RECONNECT_SCOPES: readonly ReconnectScope[] = ["off", "session", "global"];

/** How many times one outage may resume the work before the feature gives up. */
export const RECONNECT_DEFAULT_MAX_RESUMES_PER_OUTAGE = 3;

export type ReconnectSkipReason =
	| "disabled"
	| "not-enabled"
	| "malformed-policy"
	| "not-applicable"
	| "budget-exhausted"
	| "already-resumed";

export type ReconnectDecision =
	| { action: "none"; reason: ReconnectSkipReason }
	| { action: "wait" }
	| { action: "resume"; prompt: string };

export interface ReconnectDecisionInput {
	scope: ReconnectScope;
	sessionEnabled: boolean;
	policyMalformed: boolean;
	/** The probe says the machine cannot reach the internet. */
	machineOffline: boolean;
	/** The failure is a billing, authentication, or bad-request failure: waiting cannot help. */
	permanentFailure: boolean;
	budgetRemaining: boolean;
	pendingResumes: readonly PendingResume[];
	sessionId: string;
	entryId: string;
}

/**
 * Decides what the extension does with a failed turn.
 *
 * The two axes stay apart: the connectivity probe decides whether the machine
 * is offline, and the error classification decides whether waiting could ever
 * help. A provider timeout on a machine with internet is none of this
 * feature's business — the retry sequence owns it.
 */
export function decideReconnect(input: ReconnectDecisionInput): ReconnectDecision {
	if (input.scope === "off") return { action: "none", reason: "disabled" };
	if (input.policyMalformed) return { action: "none", reason: "malformed-policy" };
	if (input.scope === "session" && !input.sessionEnabled) return { action: "none", reason: "not-enabled" };
	if (hasPendingResume(input.pendingResumes, input.sessionId, input.entryId)) {
		return { action: "none", reason: "already-resumed" };
	}
	if (input.permanentFailure) return { action: "none", reason: "not-applicable" };
	if (!input.machineOffline) return { action: "none", reason: "not-applicable" };
	if (!input.budgetRemaining) return { action: "none", reason: "budget-exhausted" };
	return { action: "wait" };
}

export interface ReconnectResumeInput {
	scope: ReconnectScope;
	sessionEnabled: boolean;
	policyMalformed: boolean;
	/** The probe says the connectivity is back. */
	machineOnline: boolean;
	permanentFailure: boolean;
	budgetRemaining: boolean;
	pendingResumes: readonly PendingResume[];
	sessionId: string;
	entryId: string;
}

/**
 * Decides whether an interrupted turn is resumed with a continuation prompt.
 *
 * This is the fallback path: the turn already ended, so the work continues in
 * a new run with an explicit message, the same way OpenCode continues a turn
 * after its server restarted.
 */
export function decideReconnectResume(input: ReconnectResumeInput): ReconnectDecision {
	if (input.scope === "off") return { action: "none", reason: "disabled" };
	if (input.policyMalformed) return { action: "none", reason: "malformed-policy" };
	if (input.scope === "session" && !input.sessionEnabled) return { action: "none", reason: "not-enabled" };
	if (hasPendingResume(input.pendingResumes, input.sessionId, input.entryId)) {
		return { action: "none", reason: "already-resumed" };
	}
	if (input.permanentFailure) return { action: "none", reason: "not-applicable" };
	if (!input.machineOnline) return { action: "none", reason: "not-applicable" };
	if (!input.budgetRemaining) return { action: "none", reason: "budget-exhausted" };
	return { action: "resume", prompt: RECONNECT_PROMPT };
}

/**
 * The budget of one outage: how many times the work may be resumed before
 * the feature stops trying. It is reset when the connectivity returns.
 */
export class ReconnectBudget {
	readonly #max: number;
	#used = 0;

	constructor(max: number = RECONNECT_DEFAULT_MAX_RESUMES_PER_OUTAGE) {
		this.#max = Math.max(0, max);
	}

	get used(): number {
		return this.#used;
	}

	get remaining(): boolean {
		return this.#used < this.#max;
	}

	consume(): void {
		this.#used += 1;
	}

	reset(): void {
		this.#used = 0;
	}
}
