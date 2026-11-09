export { default } from "./extension.js";
export { createGentleRetryExtension, resetExtensionState } from "./extension.js";
export type { RetryPolicyValue, ResolvedRetryPolicy } from "./retry-policy.js";
export type { TransientFailureKind } from "./retry-classification.js";
export { resolveRetryPolicy, writeRetryPolicy, readRetryPolicyValue, gentlePiConfigHome, retryPolicyPaths } from "./retry-policy.js";
export type { RetryPolicyPaths } from "./retry-policy.js";
export {
	AUTO_RESUME_PROMPT,
	autoResumeMarkerPath,
	decideAutoResume,
	detectInterruptedTurn,
	readAutoResumeMarker,
	writeAutoResumeMarker,
} from "./auto-resume.js";
export type { AutoResumeDecision, AutoResumeMarker, InterruptedTurn } from "./auto-resume.js";
export { classifyTransientFailure } from "./retry-classification.js";
export { ONBOARDING_MESSAGE, readOnboardingMarker, writeOnboardingMarker } from "./retry-onboarding.js";
export {
	CONNECTIVITY_DEFAULT_ENDPOINT,
	CONNECTIVITY_DEFAULT_INTERVAL_MS,
	CONNECTIVITY_DEFAULT_TIMEOUT_MS,
	CONNECTIVITY_OFFLINE_THRESHOLD,
	ConnectivityWatcher,
	probeConnectivity,
} from "./connectivity.js";
export type {
	ConnectivityProbeOptions,
	ConnectivityState,
	ConnectivityWatcherOptions,
	FetchLike,
} from "./connectivity.js";
export {
	RECONNECT_DEFAULT_MAX_RESUMES_PER_OUTAGE,
	RECONNECT_PROMPT,
	RECONNECT_SCOPES,
	ReconnectBudget,
	decideReconnect,
	decideReconnectResume,
} from "./reconnect.js";
export type {
	ReconnectDecision,
	ReconnectDecisionInput,
	ReconnectResumeInput,
	ReconnectScope,
	ReconnectSkipReason,
} from "./reconnect.js";
export {
	LEGACY_AUTO_RESUME_FILE,
	LEGACY_AUTO_RESUME_SCHEMA,
	PENDING_RESUME_FILE,
	PENDING_RESUME_SCHEMA,
	hasPendingResume,
	pendingResumePath,
	readPendingResumes,
	writePendingResume,
} from "./pending-resume.js";
export type { PendingResume, PendingResumeReason } from "./pending-resume.js";
