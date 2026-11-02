import assert from "node:assert/strict";
import test from "node:test";
import { classifyTransientFailure, type TransientFailureKind } from "../dist/retry-classification.js";

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