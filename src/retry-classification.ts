export type TransientFailureKind = "rate_limit" | "timeout";

export const TRANSIENT_FAILURE_LABEL: Record<TransientFailureKind, string> = {
	rate_limit: "HTTP 429 / rate limit",
	timeout: "timeout",
};

const QUOTA_PATTERN = /\b(insufficient[_\s-]?quota|out[_\s-]?of[_\s-]?budget|quota[_\s-]?exceeded|billing|available[_\s-]?balance|monthly[_\s-]?usage[_\s-]?limit|subscription[_\s-]?sharing|credit[_\s-]?limit|spending[_\s-]?limit|payment[_\s-]?required|upgrade[_\s-]?required|plan[_\s-]?limit)\b/i;

const RATE_LIMIT_PATTERN = /\b(429\b|too[_\s-]?many[_\s-]?requests|rate[_\s-]?limit|rate[_\s-]?limited|throttle[d]?)\b/i;

const TIMEOUT_PATTERN = /\b(timed[_\s-]?out|timeout|ETIMEDOUT|deadline[_\s-]?exceeded|connection[_\s-]?timeout|request[_\s-]?timeout)\b/i;

export function classifyTransientFailure(errorMessage: string): TransientFailureKind | undefined {
	if (QUOTA_PATTERN.test(errorMessage)) return undefined;
	if (RATE_LIMIT_PATTERN.test(errorMessage)) return "rate_limit";
	if (TIMEOUT_PATTERN.test(errorMessage)) return "timeout";
	return undefined;
}