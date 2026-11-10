import assert from "node:assert/strict";
import test from "node:test";
import { classifyTransientFailure, parseRetryAfterMs, type TransientFailureKind } from "../src/retry-classification.ts";

const RATE_LIMIT_CASES: string[] = [
	"Error: 429 {\"status\":429,\"title\":\"Too Many Requests\"}",
	"HTTP 429 Too Many Requests",
	"rate limit exceeded",
	"rate_limit error",
	"throttled",
	"too many requests",
];

const TIMEOUT_CASES: string[] = [
	"Error: timed out",
	"timeout",
	"ETIMEDOUT",
	"deadline exceeded",
	"connection timeout",
	"request timeout",
];

const QUOTA_CASES: string[] = [
	"insufficient quota",
	"out of budget",
	"quota exceeded",
	"billing error",
	"available balance too low",
	"monthly usage limit reached",
	"subscription sharing limit",
	"credit limit reached",
	"spending limit exceeded",
	"payment required",
	"upgrade required",
	"plan limit",
];

const NON_TRANSIENT: string[] = [
	"authentication failed",
	"invalid api key",
	"model not found",
	"context length exceeded",
	"unknown error",
	"",
];

const REQUESTED_TRANSIENT_CASES: Array<[string, TransientFailureKind]> = [
	["Error: Request timed out.", "timeout"],
	["Error: Connection error.", "connection"],
	["Error: Retry failed after 3 attempts: Connection error.", "connection"],
	['Error: 429 {"status":429,"title":"Too Many Requests"}', "rate_limit"],
	["Error: 502 <html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Gateway</h1></center> <hr><center>openresty</center> </body> </html>", "gateway"],
	["Error: Retry failed after 1 attempts: 400 {\"status\":400,\"title\":\"Bad Request\",\"detail\":\"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked\"}", "degraded_function"],
	["Error: 400 {\"status\":400,\"title\":\"Bad Request\",\"detail\":\"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked\"}", "degraded_function"],
	["Error: Stream ended without finish_reason", "incomplete_stream"],
];

const BARE_TRANSIENT_CASES: Array<[string, TransientFailureKind]> = [
	["Request timed out.", "timeout"],
	["Connection error.", "connection"],
	['429 {"status":429,"title":"Too Many Requests"}', "rate_limit"],
	["502 <html> <head><title>502 Bad Gateway</title></head> <body> <center><h1>502 Bad Gateway</h1></center> <hr><center>openresty</center> </body> </html>", "gateway"],
	["400 {\"status\":400,\"title\":\"Bad Request\",\"detail\":\"Function id 'eb8265c4-e47d-4047-918d-c12746cc2cee': DEGRADED function cannot be invoked\"}", "degraded_function"],
	["Stream ended without finish_reason", "incomplete_stream"],
];

test("classifies HTTP 429 and rate limit variants as rate_limit", () => {
	for (const msg of RATE_LIMIT_CASES) {
		const result = classifyTransientFailure(msg);
		assert.equal(result, "rate_limit", `expected rate_limit for: ${msg}`);
	}
});

test("classifies timeout variants as timeout", () => {
	for (const msg of TIMEOUT_CASES) {
		const result = classifyTransientFailure(msg);
		assert.equal(result, "timeout", `expected timeout for: ${msg}`);
	}
});

test("never classifies quota/billing errors as transient", () => {
	for (const msg of QUOTA_CASES) {
		const result = classifyTransientFailure(msg);
		assert.equal(result, undefined, `expected undefined for quota: ${msg}`);
	}
});

test("returns undefined for non-transient errors", () => {
	for (const msg of NON_TRANSIENT) {
		const result = classifyTransientFailure(msg);
		assert.equal(result, undefined, `expected undefined for: ${msg}`);
	}
});

test("quota patterns win over rate limit when both appear", () => {
	const msg = "429 quota exceeded rate limit";
	const result = classifyTransientFailure(msg);
	assert.equal(result, undefined);
});

test("classifies every exact requested transient failure", () => {
	for (const [message, expected] of REQUESTED_TRANSIENT_CASES) {
		assert.equal(classifyTransientFailure(message), expected, message);
	}
});

test("classifies both bare and retry-wrapper forms of the requested failures", () => {
	for (const [bare, expected] of BARE_TRANSIENT_CASES) {
		assert.equal(classifyTransientFailure(bare), expected, bare);
		assert.equal(classifyTransientFailure(`Error: Retry failed after 3 attempts: ${bare}`), expected, bare);
	}
});

test("does not classify generic HTTP 400 failures as transient", () => {
	const genericBadRequests = [
		'Error: 400 {"status":400,"title":"Bad Request"}',
		'Error: Retry failed after 1 attempts: 400 {"status":400,"title":"Bad Request","detail":"Invalid request"}',
		'Error: 400 {"status":400,"title":"Bad Request","detail":"The request timed out"}',
		"Error: Bad Request: The request timed out",
		"HTTP 400 Bad Request",
	];
	for (const message of genericBadRequests) {
		assert.equal(classifyTransientFailure(message), undefined, message);
	}
});

test("quota, billing, payment, upgrade, authentication, and authorization failures stay non-transient", () => {
	const nonRetryable = [
		"quota exhausted",
		"quota timeout",
		"billing timeout",
		"credit exhausted",
		"payment failed",
		"upgrade unavailable",
		"429 authentication failed rate limit",
		"400 request timeout authorization failed",
	];
	for (const message of nonRetryable) {
		assert.equal(classifyTransientFailure(message), undefined, message);
	}
});

test("parses Retry-After seconds and HTTP dates defensively", () => {
	assert.equal(parseRetryAfterMs("429 Too Many Requests; Retry-After: 12"), 12_000);
	assert.equal(parseRetryAfterMs('{"error":{"retry_after":2}}'), 2_000);
	assert.equal(parseRetryAfterMs('{"error":{"retryAfter":3}}'), 3_000);
	assert.equal(parseRetryAfterMs('{"error":{"retry-after":"4"}}'), 4_000);
	assert.equal(parseRetryAfterMs("429 Retry-After: Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("2015-10-21T07:27:00Z")), 60_000);
	assert.equal(parseRetryAfterMs("429 without retry guidance"), undefined);
	assert.equal(parseRetryAfterMs("429 Retry-After: invalid"), undefined);
	assert.equal(parseRetryAfterMs("429 Retry-After: -1"), undefined);
});