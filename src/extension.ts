import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	ContextEditEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	ProjectedSessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome, readRetryPolicyValue, resolveRetryPolicy, retryPolicyPaths, writeRetryPolicy } from "./retry-policy.js";
import { AUTO_RESUME_PROMPT, decideAutoResume, readAutoResumeMarker, writeAutoResumeMarker } from "./auto-resume.js";
import { ConnectivityWatcher, type FetchLike } from "./connectivity.js";
import {
	decideReconnect,
	decideReconnectResume,
	ReconnectBudget,
	type ReconnectScope,
} from "./reconnect.js";
import {
	hasPendingResume,
	readPendingResumes,
	writePendingResume,
	type PendingResume,
} from "./pending-resume.js";
import {
	classifyPermanentFailure,
	classifyTransientFailure,
	parseRetryAfterMs,
	TRANSIENT_FAILURE_LABEL,
} from "./retry-classification.js";
import {
	ONBOARDING_MESSAGE,
	readOnboardingMarker,
	shouldAnnounceOnboarding,
	writeOnboardingMarker,
} from "./retry-onboarding.js";
import { guardExtensionEvents } from "./stale-context.js";

const RETRY_STATUS_TEXT = "Transient provider retry";
const OFF_TEXT = "OFF";
const ON_TEXT = "ON";
const RECONNECT_WAIT_MS = 300_000;
/** How long a session keeps watching for the connectivity after its turn ended. */
const RECONNECT_FALLBACK_MAX_WAIT_MS = 3_600_000;
let reconnectFallbackMaxWaitMs = RECONNECT_FALLBACK_MAX_WAIT_MS;

interface ReconnectWaitState {
	controller: AbortController;
	entryId: string;
	permanentFailure: boolean;
	promise: Promise<void>;
}

interface ReconnectSessionState {
	watcher: ConnectivityWatcher;
	budget: ReconnectBudget;
	offlineWaitMs: number;
	wait?: ReconnectWaitState;
}

interface FailedAttempt {
	index: number;
	errorMessage: string;
}

const attemptBySession = new Map<string, number>();
const firstFailureAtBySession = new Map<string, number>();
const pausedSessions = new Set<string>();
const reconnectStates = new Map<string, ReconnectSessionState>();
const reconnectOptInSessions = new Set<string>();
let connectivityFetchForTesting: FetchLike | undefined;

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getSessionId?.() ?? "default";
}

function resetAttempts(ctx: ExtensionContext): void {
	const key = sessionKey(ctx);
	attemptBySession.delete(key);
	firstFailureAtBySession.delete(key);
	const reconnectState = reconnectStates.get(key);
	if (reconnectState) reconnectState.offlineWaitMs = 0;
}

function isPaused(ctx: ExtensionContext): boolean {
	return pausedSessions.has(sessionKey(ctx));
}

function isReconnectSessionEnabled(ctx: ExtensionContext): boolean {
	return reconnectOptInSessions.has(sessionKey(ctx));
}

function reconnectSessionState(ctx: ExtensionContext): ReconnectSessionState {
	const key = sessionKey(ctx);
	let state = reconnectStates.get(key);
	if (!state) {
		state = {
			watcher: new ConnectivityWatcher({ fetchImpl: connectivityFetchForTesting }),
			budget: new ReconnectBudget(),
			offlineWaitMs: 0,
		};
		reconnectStates.set(key, state);
	}
	return state;
}

function reconnectParticipates(scope: ReconnectScope, ctx: ExtensionContext): boolean {
	return scope === "global" || (scope === "session" && isReconnectSessionEnabled(ctx));
}

function formatLimit(value: number | undefined, suffix: string): string {
	return value === undefined ? "unlimited" : `${value}${suffix}`;
}

function policyStatus(
	policy: ReturnType<typeof resolveRetryPolicy>,
	paused: boolean,
	reconnectSessionEnabled: boolean,
): string {
	return [
		`${RETRY_STATUS_TEXT} ${policy.policy === "on" ? ON_TEXT : OFF_TEXT}`,
		`source: ${policy.source}${policy.malformed ? `, malformed ${policy.malformedSource ?? "file"}` : ""}`,
		`delays: ${policy.baseDelayMs}ms-${policy.maxDelayMs}ms`,
		`max attempts: ${formatLimit(policy.maxAttempts, "")}`,
		`max elapsed: ${formatLimit(policy.maxElapsedMs, "ms")}`,
		`paused: ${paused ? "yes" : "no"}`,
		`auto resume: ${policy.autoResume ? ON_TEXT : OFF_TEXT}`,
		`reconnect: ${policy.reconnect}`,
		`reconnect session opt-in: ${reconnectSessionEnabled ? "yes" : "no"}`,
	].join(" | ");
}

function nextAttempt(ctx: ExtensionContext): number {
	const key = sessionKey(ctx);
	const attempt = (attemptBySession.get(key) ?? 0) + 1;
	attemptBySession.set(key, attempt);
	return attempt;
}

function retryDelayMs(attempt: number, base: number, max: number): number {
	const exponential = base * Math.pow(1.8, attempt - 1);
	const jitter = exponential * 0.1 * Math.random();
	return Math.round(Math.min(exponential + jitter, max));
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

function branchEntryHasUserMessage(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const candidate = entry as {
		message?: { role?: unknown };
		messages?: Array<{ role?: unknown }>;
	};
	if (candidate.message?.role === "user") return true;
	return Array.isArray(candidate.messages) && candidate.messages.some((message) => message.role === "user");
}

/**
 * The id of the user entry whose turn was interrupted. The branch is the
 * source of truth, matching auto-resume's session-entry shape. The boundary
 * preview is only a fallback for embedders that do not expose a branch.
 */
function interruptedUserEntryId(
	ctx: ExtensionContext,
	event?: AgentBeforeSettleEvent,
): string | undefined {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { id?: unknown } | undefined;
		if (!branchEntryHasUserMessage(entry)) continue;
		if (typeof entry?.id === "string" && entry.id.length > 0) return entry.id;
	}
	const entries = event?.context.contextEntries ?? [];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		const hasUser = entry.messages.some((message) => (message as { role?: unknown }).role === "user");
		if (hasUser && entry.sourceEntry.id.length > 0) return entry.sourceEntry.id;
	}
	return undefined;
}

function pendingResumes(configHome: string): PendingResume[] {
	try {
		return readPendingResumes(configHome);
	} catch {
		return [];
	}
}

/**
 * A single failed probe is not enough to declare an outage. When this probe
 * is the first consecutive failure, the second one establishes the offline
 * state required by the connectivity contract.
 */
async function machineIsOffline(watcher: ConnectivityWatcher): Promise<boolean> {
	let state = await watcher.refresh();
	if (watcher.consecutiveFailures === 1 && state !== "offline") state = await watcher.refresh();
	return state === "offline";
}

async function runReconnectWait(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	state: ReconnectSessionState,
	wait: ReconnectWaitState,
): Promise<void> {
	try {
		// The watch is bounded: it ends when the connectivity returns, when the
		// user stops it, when the budget runs out, or when its own limit is
		// reached. It never waits forever in the background.
		const deadline = Date.now() + reconnectFallbackMaxWaitMs;
		let online = false;
		while (!online) {
			if (wait.controller.signal.aborted) return;
			if (!state.budget.remaining) return;
			if (Date.now() >= deadline) {
				ctx.ui.notify("Stopped waiting for the network: the reconnect wait reached its limit.", "warning");
				return;
			}
			const remaining = Math.max(1, deadline - Date.now());
			const connectivity = await state.watcher.waitForOnline(
				Math.min(RECONNECT_WAIT_MS, remaining),
				wait.controller.signal,
			);
			if (connectivity === "online") {
				online = true;
				break;
			}
		}

		const policy = resolveRetryPolicy(ctx.cwd);
		const configHome = gentlePiConfigHome();
		const decision = decideReconnectResume({
			scope: policy.reconnect,
			sessionEnabled: isReconnectSessionEnabled(ctx),
			policyMalformed: policy.malformed === true,
			machineOnline: true,
			permanentFailure: wait.permanentFailure,
			budgetRemaining: state.budget.remaining,
			pendingResumes: pendingResumes(configHome),
			sessionId: sessionKey(ctx),
			entryId: wait.entryId,
		});
		if (decision.action === "resume") {
			pi.sendUserMessage(decision.prompt, { deliverAs: "followUp" });
			writePendingResume(configHome, {
				sessionId: sessionKey(ctx),
				entryId: wait.entryId,
				reason: "reconnect",
			});
			state.budget.consume();
		}
	} catch {
		// A failed handoff leaves the turn resumable by a later reconnect wait.
	} finally {
		if (state.wait === wait) state.wait = undefined;
	}
}

/** Stops the reconnect watch of this session, if one is running. */
function abortReconnectWait(ctx: ExtensionContext): void {
	reconnectStates.get(sessionKey(ctx))?.wait?.controller.abort();
}

/** Arms at most one fallback reconnect wait for a session. */
function armReconnectWait(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	entryId: string | undefined,
	permanentFailure: boolean,
): void {
	if (!entryId) return;
	const state = reconnectSessionState(ctx);
	if (state.wait || !state.budget.remaining) return;
	const wait: ReconnectWaitState = {
		controller: new AbortController(),
		entryId,
		permanentFailure,
		promise: Promise.resolve(),
	};
	state.wait = wait;
	ctx.ui.notify(
		"The network is still down. This session keeps watching in the background and resumes by itself; use /gentle:retry reconnect disable to stop it.",
	);
	wait.promise = runReconnectWait(ctx, pi, state, wait);
	void wait.promise.catch(() => {});
}

/** Builds the same context omission used by the normal retry path. */
function continuationResult(
	ctx: ExtensionContext,
	event: AgentBeforeSettleEvent,
	failed: FailedAttempt,
	notice: string,
): AgentBeforeSettleEventResult | undefined {
	const alreadyTargeted = new Set(
		event.entries
			.filter((entry): entry is ContextEditEntryDraft => entry.type === "context_edit")
			.map((entry) => entry.targetId),
	);
	const drafts = omissionDrafts(event.context.contextEntries, failed).filter(
		(draft) => !alreadyTargeted.has(draft.targetId),
	);
	if (drafts.length === 0) return undefined;
	ctx.ui.notify(notice);
	return { entries: [...event.entries, ...drafts], continue: true };
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

/**
 * The interactive menu: one entry per action of the command surface.
 *
 * The chosen entry is handed back to the command handler, so the menu and
 * the argument forms run exactly the same code.
 */
async function openRetryMenu(
	ctx: ExtensionContext,
	run: (args: string, ctx: ExtensionContext) => Promise<void>,
): Promise<void> {
	const policy = resolveRetryPolicy(ctx.cwd);
	const paused = isPaused(ctx);
	const reconnectSessionEnabled = isReconnectSessionEnabled(ctx);
	const entries = [
		{ label: "Enable for this project", action: "enable" },
		{ label: "Disable for this project", action: "disable" },
		{ label: "Enable for every project", action: "enable --global" },
		{ label: "Disable for every project", action: "disable --global" },
		{
			label: paused ? "Resume retrying in this session" : "Pause retrying in this session",
			action: paused ? "resume" : "pause",
		},
		{
			label: policy.autoResume ? "Auto-resume: off" : "Auto-resume: on",
			action: `auto-resume ${policy.autoResume ? "off" : "on"}`,
		},
		{ label: "Reconnect: global (every open session)", action: "reconnect global" },
		{ label: "Reconnect: session (opt-in per session)", action: "reconnect session" },
		{ label: "Reconnect: off (this project)", action: "reconnect off" },
		{
			label: reconnectSessionEnabled ? "Reconnect for this session: off" : "Reconnect for this session: on",
			action: reconnectSessionEnabled ? "reconnect disable" : "reconnect enable",
		},
		{ label: "Show status", action: "status" },
		{ label: "Show diagnostics", action: "doctor" },
	];
	const selected = await ctx.ui.select(
		`Gentle retry (current: ${policy.policy})`,
		entries.map((entry) => entry.label),
	);
	if (selected === undefined) return;
	const chosen = entries.find((entry) => entry.label === selected);
	if (!chosen) return;
	await run(chosen.action, ctx);
}

function createRetryCommand() {
	return async function retryCommand(args: string, ctx: ExtensionContext): Promise<void> {
		if (!args.trim() && ctx.hasUI && typeof ctx.ui.select === "function") {
			await openRetryMenu(ctx, retryCommand);
			return;
		}
		const trimmed = args.trim().toLowerCase();
		const policy = resolveRetryPolicy(ctx.cwd);
		const paused = isPaused(ctx);
		const reconnectSessionEnabled = isReconnectSessionEnabled(ctx);
		if (!trimmed || trimmed === "status") {
			ctx.ui.notify(policyStatus(policy, paused, reconnectSessionEnabled));
			return;
		}
		if (trimmed === "enable" || trimmed === "enable --global") {
			const global = trimmed.endsWith(" --global");
			writeRetryPolicy("on", ctx.cwd, { global });
			resetAttempts(ctx);
			ctx.ui.notify(`${RETRY_STATUS_TEXT} enabled (${global ? "global" : "project"})`);
			return;
		}
		if (trimmed === "disable" || trimmed === "disable --global") {
			const global = trimmed.endsWith(" --global");
			writeRetryPolicy("off", ctx.cwd, { global });
			resetAttempts(ctx);
			ctx.ui.notify(`${RETRY_STATUS_TEXT} disabled (${global ? "global" : "project"})`);
			return;
		}
		if (trimmed === "pause") {
			pausedSessions.add(sessionKey(ctx));
			resetAttempts(ctx);
			ctx.ui.notify(`${RETRY_STATUS_TEXT} paused for this session`);
			return;
		}
		if (trimmed === "resume") {
			pausedSessions.delete(sessionKey(ctx));
			resetAttempts(ctx);
			ctx.ui.notify(`${RETRY_STATUS_TEXT} resumed for this session`);
			return;
		}
		if (
			trimmed === "auto-resume on" ||
			trimmed === "auto-resume on --global" ||
			trimmed === "auto-resume off" ||
			trimmed === "auto-resume off --global"
		) {
			const global = trimmed.endsWith(" --global");
			const enabled = trimmed.startsWith("auto-resume on");
			// The flag changes in one scope only; that scope keeps its own on/off state.
			const current = readRetryPolicyValue(ctx.cwd, { global });
			writeRetryPolicy(current, ctx.cwd, { global, autoResume: enabled });
			ctx.ui.notify(`Auto-resume ${enabled ? "enabled" : "disabled"} (${global ? "global" : "project"})`);
			return;
		}
		if (trimmed === "reconnect off" || trimmed === "reconnect session" || trimmed === "reconnect global") {
			const scope = trimmed.slice("reconnect ".length) as ReconnectScope;
			const global = scope === "global";
			const current = readRetryPolicyValue(ctx.cwd, { global });
			writeRetryPolicy(current, ctx.cwd, { global, reconnect: scope });
			if (scope === "off") abortReconnectWait(ctx);
			ctx.ui.notify(`Reconnect scope set to ${scope} (${global ? "global" : "project"})`);
			return;
		}
		if (trimmed === "reconnect enable" || trimmed === "reconnect disable") {
			const enabled = trimmed.endsWith("enable");
			if (enabled) reconnectOptInSessions.add(sessionKey(ctx));
			else {
				reconnectOptInSessions.delete(sessionKey(ctx));
				abortReconnectWait(ctx);
			}
			ctx.ui.notify(`Reconnect ${enabled ? "enabled" : "disabled"} for this session`);
			return;
		}
		if (trimmed === "doctor") {
			const configHome = gentlePiConfigHome();
			const paths = retryPolicyPaths(ctx.cwd);
			const diagnostics = [
				`policy: ${policy.policy === "on" ? ON_TEXT : OFF_TEXT}`,
				`source: ${policy.source}${policy.malformed ? `, malformed ${policy.malformedSource ?? "file"}` : ""}`,
				`delays: ${policy.baseDelayMs}ms-${policy.maxDelayMs}ms`,
				`max attempts: ${formatLimit(policy.maxAttempts, "")}`,
				`max elapsed: ${formatLimit(policy.maxElapsedMs, "ms")}`,
				`paused: ${paused ? "yes" : "no"}`,
				`auto resume: ${policy.autoResume ? ON_TEXT : OFF_TEXT}`,
				`reconnect: ${policy.reconnect}`,
				`reconnect session opt-in: ${reconnectSessionEnabled ? "yes" : "no"}`,
				`project policy: ${paths.project}`,
				`global policy: ${paths.global}`,
				`config home: ${configHome}`,
				`install: pi install npm:gentle-retry`,
			];
			ctx.ui.notify(`gentle-retry doctor — ${diagnostics.join(" | ")}`, "info");
			return;
		}
		ctx.ui.notify(
			"Use /gentle:retry enable [--global]|disable [--global]|status|pause|resume|auto-resume <on|off> [--global]|reconnect <off|session|global|enable|disable>|doctor. State unchanged.",
		);
	};
}

/**
 * Introduces the extension once per install. Pi has no load-time event and no
 * per-install state, so this runs on `session_start` and remembers itself in a
 * marker file inside the config home.
 */
function announceOnboarding(ctx: ExtensionContext): void {
	if (!ctx.hasUI || !ctx.ui?.notify) return;
	const policy = resolveRetryPolicy(ctx.cwd);
	let configHome: string;
	try {
		configHome = gentlePiConfigHome();
	} catch {
		return;
	}
	const marker = readOnboardingMarker(configHome);
	if (!shouldAnnounceOnboarding({ policy: policy.policy, hasUI: true, marker })) return;
	ctx.ui.notify(ONBOARDING_MESSAGE, "info");
	try {
		writeOnboardingMarker(configHome);
	} catch {
		// A read-only home must not break the session; the worst case is one more
		// greeting, which is better than a failed start.
	}
}

/**
 * Continues the last turn when the session was reopened after an interruption.
 *
 * The continuation is a normal user message: Pi runs it like any other prompt.
 * The durable marker is written after the message is handed over, so a crash
 * in between leaves the turn resumable, while a continuation that already
 * reached the transcript is recognized by its own text and never repeated.
 */
function autoResumeOnSessionStart(event: SessionStartEvent, ctx: ExtensionContext, pi: ExtensionAPI): void {
	const policy = resolveRetryPolicy(ctx.cwd);
	if (!policy.autoResume || policy.malformed) return;
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
	let configHome: string;
	try {
		configHome = gentlePiConfigHome();
	} catch {
		return;
	}
	const decision = decideAutoResume({
		autoResumeEnabled: policy.autoResume,
		policyMalformed: policy.malformed === true,
		sessionMode: ctx.mode,
		startReason: event?.reason,
		entries: branch,
		marker: readAutoResumeMarker(configHome),
		sessionId,
	});
	if (!decision.resume) return;
	if (hasPendingResume(readPendingResumes(configHome), sessionId, decision.entryId)) return;
	try {
		pi.sendUserMessage(decision.prompt);
	} catch {
		// A session that cannot take the message yet leaves the turn resumable.
		return;
	}
	try {
		writePendingResume(configHome, { sessionId, entryId: decision.entryId, reason: "auto-resume" });
	} catch {
		// The legacy marker below still protects auto-resume from repeating.
	}
	try {
		writeAutoResumeMarker(configHome, { sessionId, entryId: decision.entryId });
	} catch {
		// A read-only home must not break the session start.
	}
	ctx.ui?.notify?.("Resuming the interrupted turn…", "info");
}

/**
 * Introduces the extension once per install and continues an interrupted turn.
 */
function sessionStart(event: SessionStartEvent, ctx: ExtensionContext, pi: ExtensionAPI): void {
	announceOnboarding(ctx);
	autoResumeOnSessionStart(event, ctx, pi);
}

/**
 * Runs after Pi has exhausted its own retry budget and before the run settles.
 * The failed attempt is still the last assistant message in the projection.
 */
async function agentBeforeSettleHandler(
	event: AgentBeforeSettleEvent,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<AgentBeforeSettleEventResult | void> {
	if (event.outcome !== "error") {
		resetAttempts(ctx);
		// The reconnect budget is released by real progress only: an aborted
		// turn is not progress, so it must not hand back the resume allowance.
		if (event.outcome === "completed") reconnectStates.get(sessionKey(ctx))?.budget.reset();
		return;
	}
	const policy = resolveRetryPolicy(ctx.cwd);
	const failed = findFailedAttempt(event.context.contextEntries);
	if (!failed) {
		resetAttempts(ctx);
		return;
	}

	const permanentFailure = classifyPermanentFailure(failed.errorMessage) !== undefined;
	if (reconnectParticipates(policy.reconnect, ctx)) {
		const reconnectState = reconnectSessionState(ctx);
		const machineOffline = await machineIsOffline(reconnectState.watcher);
		let configHome: string | undefined;
		try {
			configHome = gentlePiConfigHome();
		} catch {
			configHome = undefined;
		}
		const entryId = interruptedUserEntryId(ctx, event);
		const decision = decideReconnect({
			scope: policy.reconnect,
			sessionEnabled: isReconnectSessionEnabled(ctx),
			policyMalformed: policy.malformed === true,
			machineOffline,
			permanentFailure,
			budgetRemaining: reconnectState.budget.remaining,
			pendingResumes: configHome ? pendingResumes(configHome) : [],
			sessionId: sessionKey(ctx),
			entryId: entryId ?? "",
		});
		if (decision.action === "wait") {
			const kind = classifyTransientFailure(failed.errorMessage);
			const key = sessionKey(ctx);
			if (kind) {
				firstFailureAtBySession.set(key, firstFailureAtBySession.get(key) ?? Date.now());
			}
			ctx.ui.notify("Waiting for the network to come back… Press Esc to stop.");
			const waitStartedAt = Date.now();
			let connectivity: Awaited<ReturnType<ConnectivityWatcher["waitForOnline"]>>;
			let aborted = false;
			try {
				connectivity = await reconnectState.watcher.waitForOnline(RECONNECT_WAIT_MS, ctx.signal);
			} catch {
				aborted = true;
				connectivity = reconnectState.watcher.state;
			} finally {
				reconnectState.offlineWaitMs += Math.max(0, Date.now() - waitStartedAt);
			}
			if (aborted) {
				resetAttempts(ctx);
				return;
			}
			if (connectivity === "online") {
				const result = continuationResult(
					ctx,
					event,
					failed,
					"Continuing after the network outage…",
				);
				if (result) reconnectState.budget.consume();
				return result;
			}

			// The bounded primary wait ended while the machine was still offline.
			// The turn ends as it normally would, and one fallback wait owns the
			// continuation until the connectivity returns.
			resetAttempts(ctx);
			armReconnectWait(ctx, pi, entryId, false);
			return;
		}
	}

	// From here on the existing provider retry path is unchanged.
	if (policy.policy !== "on") {
		resetAttempts(ctx);
		return;
	}
	if (isPaused(ctx)) {
		resetAttempts(ctx);
		return;
	}
	const kind = classifyTransientFailure(failed.errorMessage);
	if (!kind) {
		resetAttempts(ctx);
		return;
	}
	const key = sessionKey(ctx);
	const firstFailureAt = firstFailureAtBySession.get(key) ?? Date.now();
	firstFailureAtBySession.set(key, firstFailureAt);
	const attempt = nextAttempt(ctx);
	if (policy.maxAttempts !== undefined && attempt > policy.maxAttempts) {
		ctx.ui.notify(
			`Retry stopped: maximum attempts reached (${policy.maxAttempts}). Use /gentle:retry resume to start a new sequence.`,
			"warning",
		);
		return;
	}
	const reconnectState = reconnectStates.get(key);
	const offlineWaitMs = reconnectState?.offlineWaitMs ?? 0;
	const elapsedMs = Math.max(0, Date.now() - firstFailureAt - offlineWaitMs);
	if (policy.maxElapsedMs !== undefined && elapsedMs >= policy.maxElapsedMs) {
		ctx.ui.notify(
			`Retry stopped: maximum elapsed time reached (${policy.maxElapsedMs}ms). Use /gentle:retry resume to start a new sequence.`,
			"warning",
		);
		return;
	}
	const retryAfterMs = parseRetryAfterMs(failed.errorMessage);
	const delayMs = retryAfterMs === undefined
		? retryDelayMs(attempt, policy.baseDelayMs, policy.maxDelayMs)
		: Math.min(retryAfterMs, policy.maxDelayMs);
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
	return continuationResult(
		ctx,
		event,
		failed,
		`Continuing after ${TRANSIENT_FAILURE_LABEL[kind]} (attempt ${attempt})…`,
	);
}

export function createGentleRetryExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		// A session that was replaced or reloaded leaves a dead context behind.
		// The late events of the run that was still in flight must not become
		// extension errors.
		const guarded = guardExtensionEvents(pi);
		guarded.registerCommand("gentle:retry", {
			description: "Control and diagnose transient provider retry",
			handler: createRetryCommand(),
		});
		guarded.on("session_start", (event, ctx) => sessionStart(event, ctx, pi));
		guarded.on("session_shutdown", () => {
			for (const state of reconnectStates.values()) state.wait?.controller.abort();
		});
		guarded.on("agent_before_settle", (event, ctx) => agentBeforeSettleHandler(event, ctx, pi));
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
	firstFailureAtBySession.clear();
	pausedSessions.clear();
	for (const state of reconnectStates.values()) {
		state.wait?.controller.abort();
	}
	reconnectStates.clear();
	reconnectOptInSessions.clear();
	connectivityFetchForTesting = undefined;
	reconnectFallbackMaxWaitMs = RECONNECT_FALLBACK_MAX_WAIT_MS;
}

/** Shortens the background reconnect wait so the tests do not wait an hour. */
export function setReconnectTimingForTesting(options?: { fallbackMaxWaitMs?: number }): void {
	if (options?.fallbackMaxWaitMs !== undefined) reconnectFallbackMaxWaitMs = options.fallbackMaxWaitMs;
}

/** Injects the connectivity request used by the extension's test seam. */
export function setConnectivityFetchForTesting(fetchImpl?: FetchLike): void {
	connectivityFetchForTesting = fetchImpl;
}

export type { RetryPolicyValue, ResolvedRetryPolicy } from "./retry-policy.js";
export type { TransientFailureKind } from "./retry-classification.js";
export { resolveRetryPolicy, writeRetryPolicy } from "./retry-policy.js";
export { classifyTransientFailure } from "./retry-classification.js";
