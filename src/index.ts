export { default } from "./extension.js";
export { createGentleRetryExtension, resetExtensionState } from "./extension.js";
export type { RetryPolicyValue, ResolvedRetryPolicy } from "./retry-policy.js";
export type { TransientFailureKind } from "./retry-classification.js";
export { resolveRetryPolicy, writeRetryPolicy } from "./retry-policy.js";
export { classifyTransientFailure } from "./retry-classification.js";
