import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export const PENDING_RESUME_SCHEMA = "gentle-pi.retry-pending-resume/v1";
export const PENDING_RESUME_FILE = "retry-pending-resume.json";

/** The marker file written by the auto-resume feature before this record existed. */
export const LEGACY_AUTO_RESUME_SCHEMA = "gentle-pi.retry-auto-resume/v1";
export const LEGACY_AUTO_RESUME_FILE = "retry-auto-resume.json";

export type PendingResumeReason = "auto-resume" | "reconnect";

/**
 * The durable proof that a turn was already continued.
 *
 * Auto-resume and reconnect can both find the same interrupted turn: one
 * when the session is reopened, the other when the network comes back. The
 * record is the single place where that fact is kept, so neither path
 * continues a turn twice. It holds no message content.
 */
export interface PendingResume {
	sessionId: string;
	entryId: string;
	reason: PendingResumeReason;
	updatedAt: string;
}

export function pendingResumePath(configHome: string): string {
	return join(configHome, PENDING_RESUME_FILE);
}

function readRecord(path: string): Record<string, unknown> | undefined {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
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
	return parsed as Record<string, unknown>;
}

function toPendingResume(
	parsed: Record<string, unknown> | undefined,
	schema: string,
	fallbackReason: PendingResumeReason,
): PendingResume | undefined {
	if (!parsed || parsed.schema !== schema) return undefined;
	const sessionId = parsed.sessionId;
	const entryId = parsed.entryId;
	const updatedAt = parsed.updatedAt;
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	if (typeof entryId !== "string" || entryId.length === 0) return undefined;
	if (typeof updatedAt !== "string") return undefined;
	const reason = parsed.reason;
	return {
		sessionId,
		entryId,
		reason: reason === "auto-resume" || reason === "reconnect" ? reason : fallbackReason,
		updatedAt,
	};
}

/**
 * Every pending-resume record known for this config home: the shared record
 * and the marker written by older versions of auto-resume.
 */
export function readPendingResumes(configHome: string): PendingResume[] {
	const records: PendingResume[] = [];
	const shared = toPendingResume(readRecord(pendingResumePath(configHome)), PENDING_RESUME_SCHEMA, "reconnect");
	if (shared) records.push(shared);
	const legacy = toPendingResume(
		readRecord(join(configHome, LEGACY_AUTO_RESUME_FILE)),
		LEGACY_AUTO_RESUME_SCHEMA,
		"auto-resume",
	);
	if (legacy && !records.some((record) => record.sessionId === legacy.sessionId && record.entryId === legacy.entryId)) {
		records.push(legacy);
	}
	return records;
}

/** True when this session already continued this turn. */
export function hasPendingResume(
	records: readonly PendingResume[],
	sessionId: string,
	entryId: string,
): boolean {
	return records.some((record) => record.sessionId === sessionId && record.entryId === entryId);
}

/** Writes the record atomically, next to the other gentle-retry state. */
export function writePendingResume(
	configHome: string,
	record: { sessionId: string; entryId: string; reason: PendingResumeReason; updatedAt?: string },
): void {
	mkdirSync(configHome, { recursive: true, mode: 0o700 });
	const content = JSON.stringify(
		{
			schema: PENDING_RESUME_SCHEMA,
			sessionId: record.sessionId,
			entryId: record.entryId,
			reason: record.reason,
			updatedAt: record.updatedAt ?? new Date().toISOString(),
		},
		null,
		"\t",
	);
	atomicWriteFileSync(pendingResumePath(configHome), content, { mode: 0o600 });
}
