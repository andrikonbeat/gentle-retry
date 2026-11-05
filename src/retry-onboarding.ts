import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import type { RetryPolicyValue } from "./retry-policy.js";

export const ONBOARDING_SCHEMA = "gentle-pi.retry-onboarding/v1";
export const ONBOARDING_MARKER_FILE = "retry-onboarding.json";

/**
 * A fresh install is silent by design: the safe default is off, and an
 * unlimited retry loop must never switch itself on. Silence is also the worst
 * first-run experience, so the extension introduces itself exactly once and
 * names the command that turns it on.
 */
export const ONBOARDING_MESSAGE =
	"gentle-retry installed — OFF. Tailored for HTTP 429 and timeouts: /gentle:retry enable keeps a run alive instead of stopping.";

export type OnboardingMarkerState = "none" | "present" | "unreadable";

export interface OnboardingDecisionInput {
	policy: RetryPolicyValue;
	hasUI: boolean;
	marker: OnboardingMarkerState;
}

export function onboardingMarkerPath(configHome: string): string {
	return join(configHome, ONBOARDING_MARKER_FILE);
}

/**
 * `unreadable` is deliberately not treated as `none`: a corrupt or unreadable
 * marker must not make the extension greet the user on every single session.
 */
export function readOnboardingMarker(configHome: string): OnboardingMarkerState {
	let content: string;
	try {
		content = readFileSync(onboardingMarkerPath(configHome), "utf8");
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return code === "ENOENT" ? "none" : "unreadable";
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return "unreadable";
	}
	if (typeof parsed !== "object" || parsed === null) return "unreadable";
	if ((parsed as { schema?: unknown }).schema !== ONBOARDING_SCHEMA) return "unreadable";
	return "present";
}

/** Writes the marker atomically, and does nothing when it is already there. */
export function writeOnboardingMarker(configHome: string): void {
	const targetPath = onboardingMarkerPath(configHome);
	if (readOnboardingMarker(configHome) === "present") return;
	mkdirSync(configHome, { recursive: true, mode: 0o700 });
	const content = JSON.stringify({ schema: ONBOARDING_SCHEMA }, null, "\t");
	atomicWriteFileSync(targetPath, content, { mode: 0o600 });
}

/**
 * Announces only when the user has a UI to read it, the extension is still off
 * (an enabled install was already found), and it was never announced before.
 */
export function shouldAnnounceOnboarding(input: OnboardingDecisionInput): boolean {
	if (!input.hasUI) return false;
	if (input.policy !== "off") return false;
	return input.marker === "none";
}
