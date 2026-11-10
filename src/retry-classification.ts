export type TransientFailureKind =
	| "rate_limit"
	| "timeout"
	| "connection"
	| "gateway"
	| "degraded_function"
	| "incomplete_stream";

export const TRANSIENT_FAILURE_LABEL: Record<TransientFailureKind, string> = {
	rate_limit: "HTTP 429 / rate limit",
	timeout: "timeout",
	connection: "connection error",
	gateway: "HTTP 502 / gateway error",
	degraded_function: "degraded function",
	incomplete_stream: "incomplete stream",
};

const QUOTA_PATTERN = /\b(insufficient[_\s-]?quota|out[_\s-]?of[_\s-]?budget|quota|billing|available[_\s-]?balance|monthly[_\s-]?usage[_\s-]?limit|subscription[_\s-]?sharing|credit|spending[_\s-]?limit|payment|upgrade|plan[_\s-]?limit)\b/i;

const AUTH_PATTERN = /\b(authentication|authorization|unauthorized|forbidden|invalid[_\s-]?(?:api[_\s-]?)?key|access[_\s-]?denied|permission[_\s-]?denied|not[_\s-]?authenticated)\b/i;

const RATE_LIMIT_PATTERN = /\b(429\b|too[_\s-]?many[_\s-]?requests|rate[_\s-]?limit|rate[_\s-]?limited|throttle[d]?)\b/i;

const TIMEOUT_PATTERN = /\b(timed[_\s-]?out|timeout|ETIMEDOUT|deadline[_\s-]?exceeded|connection[_\s-]?timeout|request[_\s-]?timeout)\b/i;

const CONNECTION_PATTERN = /\b(connection[_\s-]?error|connection[_\s-]?(?:reset|closed|aborted|refused)|dropped[_\s-]?connection|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|socket[_\s-]?hang[_\s-]?up)\b/i;

const GATEWAY_PATTERN = /\b(502\b|bad[_\s-]?gateway|gateway[_\s-]?timeout)\b/i;

const DEGRADED_FUNCTION_PATTERN = /\bDEGRADED\b[\s\S]*?\bfunction\b[\s\S]*?\bcannot[_\s-]?be[_\s-]?invoked\b/i;

const HTTP_400_PATTERN = /(?:\bhttp\s*400\b|\bbad[_\s-]?request\b|\bstatus(?:[_\s-]?code)?["']?\s*[:=]\s*400\b|(?:^|[:\s])400\b)/i;

const INCOMPLETE_STREAM_PATTERN = /\bstream[_\s-]?ended\b[\s\S]*?\bwithout\b[\s\S]*?\bfinish[_\s-]?reason\b/i;

const RETRY_AFTER_SECONDS_PATTERN = /\bretry(?:[-_\s]?after)\b["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\b/i;

const RETRY_AFTER_DATE_PATTERN = /\bretry(?:[-_\s]?after)\b["']?\s*[:=]\s*["']?([^"'\r\n}]+)/i;

/**
 * Extracts a provider's Retry-After guidance from error text. Providers expose
 * this inconsistently, so the parser accepts either delta-seconds or an HTTP
 * date and returns undefined when the value is not reliable.
 */
export function parseRetryAfterMs(errorMessage: string, now = Date.now()): number | undefined {
	const secondsMatch = errorMessage.match(RETRY_AFTER_SECONDS_PATTERN);
	if (secondsMatch) {
		const seconds = Number(secondsMatch[1]);
		const milliseconds = seconds * 1_000;
		if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(milliseconds)) {
			return Math.round(milliseconds);
		}
	}

	const dateMatch = errorMessage.match(RETRY_AFTER_DATE_PATTERN);
	if (!dateMatch) return undefined;
	const value = dateMatch[1]!.trim();
	// Date.parse accepts bare numbers as years. Retry-After numbers are handled
	// above, so a value without a date component is not reliable here.
	if (!/[a-z]/i.test(value)) return undefined;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return undefined;
	return Math.max(0, timestamp - now);
}

export type PermanentFailureKind = "quota" | "auth" | "bad_request";

/**
 * Failures that waiting cannot fix.
 *
 * The reconnect feature uses this to leave billing, authentication, and bad
 * request failures alone: no amount of connectivity brings the quota back.
 * A degraded function stays out of this list because it is retryable.
 */
export function classifyPermanentFailure(errorMessage: string): PermanentFailureKind | undefined {
	if (QUOTA_PATTERN.test(errorMessage)) return "quota";
	if (AUTH_PATTERN.test(errorMessage)) return "auth";
	if (DEGRADED_FUNCTION_PATTERN.test(errorMessage)) return undefined;
	if (HTTP_400_PATTERN.test(errorMessage)) return "bad_request";
	return undefined;
}

export function classifyTransientFailure(errorMessage: string): TransientFailureKind | undefined {
	if (QUOTA_PATTERN.test(errorMessage)) return undefined;
	if (AUTH_PATTERN.test(errorMessage)) return undefined;
	if (DEGRADED_FUNCTION_PATTERN.test(errorMessage)) return "degraded_function";
	if (HTTP_400_PATTERN.test(errorMessage)) return undefined;
	if (RATE_LIMIT_PATTERN.test(errorMessage)) return "rate_limit";
	if (TIMEOUT_PATTERN.test(errorMessage)) return "timeout";
	if (CONNECTION_PATTERN.test(errorMessage)) return "connection";
	if (GATEWAY_PATTERN.test(errorMessage)) return "gateway";
	if (INCOMPLETE_STREAM_PATTERN.test(errorMessage)) return "incomplete_stream";
	return undefined;
}
