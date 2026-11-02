import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	ContextEditEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	ProjectedSessionEntry,
} from "@earendil-works/pi-coding-agent";
import { resolveRetryPolicy, writeRetryPolicy } from "./retry-policy.js";
import { classifyTransientFailure, TRANSIENT_FAILURE_LABEL } from "./retry-classification.js";
import { guardExtensionEvents } from "./stale-context.js";

const RETRY_STATUS_TEXT = "Unlimited retry on 429/timeout";
const OFF_TEXT = "OFF";
const ON_TEXT = "ON";

interface FailedAttempt {
	index: number;
	errorMessage: string;
}

const attemptBySession = new Map<string, number>();

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getSessionId?.() ?? "default";
}

function resetAttempts(ctx: ExtensionContext): void {
	attemptBySession.delete(sessionKey(ctx));
}

function nextAttempt(ctx: ExtensionContext): number {
	const key = sessionKey(ctx);
	const attempt = (attemptBySession.get(key) ?? 0) + 1;
	attemptBySession.set(key, attempt);
	return attempt;
}

function retryDelayMs(attempt: number, base: number, max: number): number {
	const jitter = base * 0.1 * Math.random();
	const delay = Math.min(base * Math.pow(1.8, attempt - 1) + jitter, max);
	return Math.round(delay);
}

function formatDelay(delayMs: number): string {
	return delayMs >= 1_000 ? `${Math.round(delayMs / 1_000)}s` : `${delayMs}ms`;
}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * The failed assistant message is the only place Pi stores the provider error
 * text: `TurnEndEvent` and `BoundaryState` carry no separate `error` field.
 */
function errorMessageOf(entry: ProjectedSessionEntry): string | undefined {
	for (const message of entry.messages) {
		const candidate = message as { role?: string; errorMessage?: unknown };
		if (candidate.role === "assistant" && typeof candidate.errorMessage === "string" && candidate.errorMessage.length > 0) {
			return candidate.errorMessage;
		}
	}
	return undefined;
}

function findFailedAttempt(entries: readonly ProjectedSessionEntry[]): FailedAttempt | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const errorMessage = errorMessageOf(entries[index]!);
		if (errorMessage) return { index, errorMessage };
	}
	return undefined;
}

function toolCallIdsOf(entry: ProjectedSessionEntry): string[] {
	const ids: string[] = [];
	for (const message of entry.messages) {
		const candidate = message as { role?: string; content?: Array<{ type?: string; id?: string }> };
		if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) continue;
		for (const block of candidate.content) {
			if (block.type === "toolCall" && typeof block.id === "string") ids.push(block.id);
		}
	}
	return ids;
}

/**
 * Omits the failed assistant message (and any tool results it produced) from
 * the model projection, matching what Pi's own retry recovery does.
 */
function omissionDrafts(
	entries: readonly ProjectedSessionEntry[],
	failed: FailedAttempt,
): ContextEditEntryDraft[] {
	const drafts: ContextEditEntryDraft[] = [
		{ type: "context_edit", targetId: entries[failed.index]!.sourceEntry.id, replacement: null },
	];
	const toolCallIds = new Set(toolCallIdsOf(entries[failed.index]!));
	if (toolCallIds.size === 0) return drafts;
	for (let index = failed.index + 1; index < entries.length; index += 1) {
		const entry = entries[index]!;
		const stopsRun = entry.messages.some((message) => {
			const role = (message as { role?: string }).role;
			return role === "assistant" || role === "user";
		});
		if (stopsRun) break;
		const hasMatchingToolResult = entry.messages.some((message) => {
			const candidate = message as { role?: string; toolCallId?: string };
			return candidate.role === "toolResult" && typeof candidate.toolCallId === "string" && toolCallIds.has(candidate.toolCallId);
		});
		if (hasMatchingToolResult) {
			drafts.push({ type: "context_edit", targetId: entry.sourceEntry.id, replacement: null });
		}
	}
	return drafts;
}

function createRetryCommand() {
	return async function retryCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const policy = resolveRetryPolicy(ctx.cwd);
		const trimmed = args.trim().toLowerCase();
		const status = `${RETRY_STATUS_TEXT} ${policy.policy === "on" ? ON_TEXT : OFF_TEXT} (source: ${policy.source}${policy.malformed ? ", malformed" : ""})`;
		if (!trimmed || trimmed === "status") {
			ctx.ui.notify(status);
			return;
		}
		if (trimmed === "enable") {
			writeRetryPolicy("on", ctx.cwd);
			resetAttempts(ctx);
			ctx.ui.notify(`${RETRY_STATUS_TEXT} enabled`);
			return;
		}
		if (trimmed === "disable") {
			writeRetryPolicy("off", ctx.cwd);
			resetAttempts(ctx);
			ctx.ui.notify(`${RETRY_STATUS_TEXT} disabled`);
			return;
		}
		ctx.ui.notify("Use /gentle:retry enable|disable|status. State unchanged.");
	};
}

/**
 * Runs after Pi has exhausted its own retry budget and before the run settles.
 * The failed attempt is still the last assistant message in the projection.
 */
async function agentBeforeSettleHandler(
	event: AgentBeforeSettleEvent,
	ctx: ExtensionContext,
): Promise<AgentBeforeSettleEventResult | void> {
	const policy = resolveRetryPolicy(ctx.cwd);
	if (policy.policy !== "on") {
		resetAttempts(ctx);
		return;
	}
	const failed = findFailedAttempt(event.context.contextEntries);
	if (!failed) {
		resetAttempts(ctx);
		return;
	}
	const kind = classifyTransientFailure(failed.errorMessage);
	if (!kind) {
		resetAttempts(ctx);
		return;
	}
	const attempt = nextAttempt(ctx);
	const delayMs = retryDelayMs(attempt, policy.baseDelayMs, policy.maxDelayMs);
	ctx.ui.notify(
		`Retry ${attempt} (${TRANSIENT_FAILURE_LABEL[kind]}) — waiting ${formatDelay(delayMs)}… Press Esc to stop.`,
	);
	try {
		await wait(delayMs, ctx.signal);
	} catch {
		resetAttempts(ctx);
		return;
	}
	if (ctx.signal?.aborted) {
		resetAttempts(ctx);
		return;
	}
	const alreadyTargeted = new Set(
		event.entries
			.filter((entry): entry is ContextEditEntryDraft => entry.type === "context_edit")
			.map((entry) => entry.targetId),
	);
	const drafts = omissionDrafts(event.context.contextEntries, failed).filter(
		(draft) => !alreadyTargeted.has(draft.targetId),
	);
	if (drafts.length === 0) return;
	ctx.ui.notify(`Continuing after ${TRANSIENT_FAILURE_LABEL[kind]} (attempt ${attempt})…`);
	return { entries: [...event.entries, ...drafts], continue: true };
}

export function createGentleRetryExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		// A session that was replaced or reloaded leaves a dead context behind.
		// The late events of the run that was still in flight must not become
		// extension errors.
		const guarded = guardExtensionEvents(pi);
		guarded.registerCommand("gentle:retry", {
			description: "Unlimited retry on HTTP 429 and timeout",
			handler: createRetryCommand(),
		});
		guarded.on("agent_before_settle", agentBeforeSettleHandler);
	};
}

/**
 * Pi loads an extension through its default export. Keep the named factory too:
 * tests and embedders use it to build isolated instances.
 */
export default function gentleRetryExtension(pi: ExtensionAPI): void {
	createGentleRetryExtension()(pi);
}

export function resetExtensionState(): void {
	attemptBySession.clear();
}

export type { RetryPolicyValue, ResolvedRetryPolicy } from "./retry-policy.js";
export type { TransientFailureKind } from "./retry-classification.js";
export { resolveRetryPolicy, writeRetryPolicy } from "./retry-policy.js";
export { classifyTransientFailure } from "./retry-classification.js";
