import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export const AUTO_RESUME_SCHEMA = "gentle-pi.retry-auto-resume/v1";
export const AUTO_RESUME_MARKER_FILE = "retry-auto-resume.json";

/**
 * Same intent as OpenCode's `CONTINUE_AFTER_SERVER_RESTART` synthetic
 * message: the run was interrupted, so continue without repeating work that
 * already completed.
 */
export const AUTO_RESUME_PROMPT =
	"The server restarted while you were working. Continue from where you left off without repeating completed work.";

/** stopReason values that mean the turn was still in flight when the process died. */
const INTERRUPTED_STOP_REASONS = new Set(["pending", "toolUse"]);

export interface AutoResumeMarker {
	schema: string;
	sessionId: string;
	entryId: string;
	updatedAt: string;
}

interface BranchMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
}

interface BranchEntry {
	id?: string;
	type?: string;
	message?: BranchMessage;
	messages?: BranchMessage[];
}

export type InterruptedTurn =
	| { interrupted: false }
	| { interrupted: true; entryId: string; userText: string };

export type AutoResumeSkipReason =
	| "disabled"
	| "malformed-policy"
	| "not-tui"
	| "wrong-reason"
	| "nothing-to-resume"
	| "already-continued";

export type AutoResumeDecision =
	| { resume: false; reason: AutoResumeSkipReason }
	| { resume: true; entryId: string; prompt: string };

export interface AutoResumeDecisionInput {
	autoResumeEnabled: boolean;
	policyMalformed: boolean;
	sessionMode: string | undefined;
	startReason: string | undefined;
	entries: readonly unknown[];
	marker: AutoResumeMarker | undefined;
	sessionId: string;
}

function messagesOf(entry: BranchEntry): BranchMessage[] {
	const messages: BranchMessage[] = [];
	if (typeof entry.message === "object" && entry.message !== null) messages.push(entry.message);
	if (Array.isArray(entry.messages)) {
		for (const message of entry.messages) {
			if (typeof message === "object" && message !== null) messages.push(message as BranchMessage);
		}
	}
	return messages;
}

function textOf(message: BranchMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type !== "text" || typeof candidate.text !== "string") continue;
		parts.push(candidate.text);
	}
	return parts.join("");
}

/**
 * Finds the turn that was still in flight when the process died.
 *
 * The branch is walked backwards: the first user message is the last user
 * message, and the first assistant message met before it is the last reply.
 * A turn is interrupted when that reply is missing (the process died before
 * the model answered) or when the reply was still running (`pending` or
 * `toolUse`). A reply that ended the turn — including an explicit abort and a
 * provider error — is never interrupted: those belong to the user or to the
 * retry sequence, not to auto-resume.
 */
export function detectInterruptedTurn(entries: readonly unknown[]): InterruptedTurn {
	if (!Array.isArray(entries)) return { interrupted: false };
	let lastUser: { entryId: string; userText: string } | undefined;
	let lastAssistant: BranchMessage | undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as BranchEntry | undefined;
		if (typeof entry !== "object" || entry === null) continue;
		for (const message of messagesOf(entry)) {
			if (message.role === "assistant") {
				if (lastAssistant === undefined) lastAssistant = message;
				continue;
			}
			if (message.role !== "user" || lastUser !== undefined) continue;
			lastUser = {
				entryId: typeof entry.id === "string" ? entry.id : "",
				userText: textOf(message),
			};
		}
		if (lastUser !== undefined) break;
	}
	if (lastUser === undefined) return { interrupted: false };
	if (lastAssistant === undefined) {
		return { interrupted: true, entryId: lastUser.entryId, userText: lastUser.userText };
	}
	if (typeof lastAssistant.stopReason === "string" && INTERRUPTED_STOP_REASONS.has(lastAssistant.stopReason)) {
		return { interrupted: true, entryId: lastUser.entryId, userText: lastUser.userText };
	}
	return { interrupted: false };
}

/**
 * Decides whether the session that just started must continue its last turn.
 *
 * The decision is pure so the whole rule set is testable without a live Pi
 * session: the extension only supplies the resolved policy, the session mode,
 * the start reason, the branch, and the durable marker.
 */
export function decideAutoResume(input: AutoResumeDecisionInput): AutoResumeDecision {
	if (!input.autoResumeEnabled) return { resume: false, reason: "disabled" };
	if (input.policyMalformed) return { resume: false, reason: "malformed-policy" };
	if (input.sessionMode !== "tui") return { resume: false, reason: "not-tui" };
	if (input.startReason !== "resume" && input.startReason !== "startup") {
		return { resume: false, reason: "wrong-reason" };
	}
	const turn = detectInterruptedTurn(input.entries);
	if (!turn.interrupted) return { resume: false, reason: "nothing-to-resume" };
	// Our own continuation is the last user message: this turn was already continued.
	if (turn.userText === AUTO_RESUME_PROMPT) return { resume: false, reason: "already-continued" };
	const marker = input.marker;
	if (marker !== undefined && marker.sessionId === input.sessionId && marker.entryId === turn.entryId) {
		return { resume: false, reason: "already-continued" };
	}
	return { resume: true, entryId: turn.entryId, prompt: AUTO_RESUME_PROMPT };
}

export function autoResumeMarkerPath(configHome: string): string {
	return join(configHome, AUTO_RESUME_MARKER_FILE);
}

/**
 * The marker is the durable memory of a continued turn. It holds no message
 * content: only which session and which entry were continued, and when.
 */
export function readAutoResumeMarker(configHome: string): AutoResumeMarker | undefined {
	let content: string;
	try {
		content = readFileSync(autoResumeMarkerPath(configHome), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const candidate = parsed as Partial<AutoResumeMarker>;
	if (candidate.schema !== AUTO_RESUME_SCHEMA) return undefined;
	if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) return undefined;
	if (typeof candidate.entryId !== "string" || candidate.entryId.length === 0) return undefined;
	if (typeof candidate.updatedAt !== "string") return undefined;
	return {
		schema: AUTO_RESUME_SCHEMA,
		sessionId: candidate.sessionId,
		entryId: candidate.entryId,
		updatedAt: candidate.updatedAt,
	};
}

/** Writes the marker atomically, next to the other gentle-retry state. */
export function writeAutoResumeMarker(
	configHome: string,
	marker: { sessionId: string; entryId: string; updatedAt?: string },
): void {
	mkdirSync(configHome, { recursive: true, mode: 0o700 });
	const content = JSON.stringify(
		{
			schema: AUTO_RESUME_SCHEMA,
			sessionId: marker.sessionId,
			entryId: marker.entryId,
			updatedAt: marker.updatedAt ?? new Date().toISOString(),
		},
		null,
		"\t",
	);
	atomicWriteFileSync(autoResumeMarkerPath(configHome), content, { mode: 0o600 });
}
