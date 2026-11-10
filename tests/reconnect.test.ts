import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

// Run the focused tests against TypeScript sources without writing build output
// outside the task's allowed edit surfaces.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { RECONNECT_PROMPT, ReconnectBudget, decideReconnect, decideReconnectResume } = await import(
	"../src/reconnect.ts"
);
const { LEGACY_AUTO_RESUME_FILE, LEGACY_AUTO_RESUME_SCHEMA, hasPendingResume, readPendingResumes, writePendingResume } =
	await import("../src/pending-resume.ts");
const { RETRY_POLICY_FILE, RETRY_POLICY_SCHEMA, resolveRetryPolicy, writeRetryPolicy } = await import(
	"../src/retry-policy.ts"
);
const { classifyPermanentFailure } = await import("../src/retry-classification.ts");

const scratchDirectories: string[] = [];
const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;

afterEach(() => {
	if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
	for (const directory of scratchDirectories.splice(0).reverse()) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {}
	}
});

function scratch(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	scratchDirectories.push(directory);
	return directory;
}

const BASE = {
	scope: "off" as const,
	sessionEnabled: false,
	policyMalformed: false,
	machineOffline: true,
	permanentFailure: false,
	budgetRemaining: true,
	pendingResumes: [],
	sessionId: "session-1",
	entryId: "entry-1",
};

test("reconnect does nothing when the scope is off", () => {
	assert.deepEqual(decideReconnect({ ...BASE, scope: "off" }), { action: "none", reason: "disabled" });
});

test("reconnect does nothing when the policy is malformed", () => {
	assert.deepEqual(decideReconnect({ ...BASE, scope: "global", policyMalformed: true }), {
		action: "none",
		reason: "malformed-policy",
	});
});

test("reconnect does nothing in session scope without the session opt-in", () => {
	assert.deepEqual(decideReconnect({ ...BASE, scope: "session", sessionEnabled: false }), {
		action: "none",
		reason: "not-enabled",
	});
});

test("reconnect waits for the connectivity in session scope with the opt-in", () => {
	assert.deepEqual(decideReconnect({ ...BASE, scope: "session", sessionEnabled: true }), { action: "wait" });
});

test("reconnect waits in global scope even without the session opt-in", () => {
	assert.deepEqual(decideReconnect({ ...BASE, scope: "global", sessionEnabled: false }), { action: "wait" });
});

test("reconnect leaves a failure alone while the machine has internet", () => {
	assert.deepEqual(decideReconnect({ ...BASE, scope: "global", machineOffline: false }), {
		action: "none",
		reason: "not-applicable",
	});
});

test("reconnect leaves a permanent failure alone", () => {
	assert.deepEqual(decideReconnect({ ...BASE, scope: "global", permanentFailure: true }), {
		action: "none",
		reason: "not-applicable",
	});
});

test("reconnect stops when the outage budget is exhausted", () => {
	assert.deepEqual(decideReconnect({ ...BASE, scope: "global", budgetRemaining: false }), {
		action: "none",
		reason: "budget-exhausted",
	});
});

test("reconnect does not wait for a turn that was already continued", () => {
	const pendingResumes = [{ sessionId: "session-1", entryId: "entry-1", reason: "reconnect" as const, updatedAt: "now" }];
	assert.deepEqual(decideReconnect({ ...BASE, scope: "global", pendingResumes }), {
		action: "none",
		reason: "already-resumed",
	});
});

test("reconnect resumes with the continuation prompt when the connectivity is back", () => {
	assert.deepEqual(decideReconnectResume({ ...BASE, scope: "global", machineOnline: true }), {
		action: "resume",
		prompt: RECONNECT_PROMPT,
	});
});

test("the continuation prompt tells the model to continue without repeating work", () => {
	assert.equal(
		RECONNECT_PROMPT,
		"The network connection was restored. Continue from where you left off without repeating completed work.",
	);
});

test("reconnect does not resume while the machine is still offline", () => {
	assert.deepEqual(decideReconnectResume({ ...BASE, scope: "global", machineOnline: false }), {
		action: "none",
		reason: "not-applicable",
	});
});

test("reconnect does not resume a turn that was already continued", () => {
	const pendingResumes = [{ sessionId: "session-1", entryId: "entry-1", reason: "auto-resume" as const, updatedAt: "now" }];
	assert.deepEqual(decideReconnectResume({ ...BASE, scope: "global", machineOnline: true, pendingResumes }), {
		action: "none",
		reason: "already-resumed",
	});
});

test("reconnect does not resume when the outage budget is exhausted", () => {
	assert.deepEqual(decideReconnectResume({ ...BASE, scope: "global", machineOnline: true, budgetRemaining: false }), {
		action: "none",
		reason: "budget-exhausted",
	});
});

test("the outage budget allows three resumes and then stops", () => {
	const budget = new ReconnectBudget();
	assert.equal(budget.remaining, true);
	budget.consume();
	budget.consume();
	budget.consume();
	assert.equal(budget.remaining, false);
	budget.reset();
	assert.equal(budget.remaining, true);
});

test("the pending resume record round-trips", () => {
	const configHome = scratch("gentle-retry-pending-");
	writePendingResume(configHome, { sessionId: "session-1", entryId: "entry-1", reason: "reconnect" });
	const records = readPendingResumes(configHome);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.sessionId, "session-1");
	assert.equal(records[0]?.entryId, "entry-1");
	assert.equal(records[0]?.reason, "reconnect");
});

test("the legacy auto-resume marker is read as an auto-resume record", () => {
	const configHome = scratch("gentle-retry-pending-legacy-");
	writeFileSync(
		join(configHome, LEGACY_AUTO_RESUME_FILE),
		JSON.stringify({
			schema: LEGACY_AUTO_RESUME_SCHEMA,
			sessionId: "session-9",
			entryId: "entry-9",
			updatedAt: "2026-01-01T00:00:00.000Z",
		}),
	);
	const records = readPendingResumes(configHome);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.reason, "auto-resume");
	assert.equal(hasPendingResume(records, "session-9", "entry-9"), true);
	assert.equal(hasPendingResume(records, "session-9", "entry-other"), false);
});

test("the reconnect scope is stored in the policy file", () => {
	const projectDir = scratch("gentle-retry-reconnect-project-");
	process.env.GENTLE_PI_CONFIG_HOME = scratch("gentle-retry-reconnect-home-");
	writeRetryPolicy("on", projectDir, { reconnect: "global" });
	assert.equal(resolveRetryPolicy(projectDir).reconnect, "global");
});

test("the reconnect scope defaults to off", () => {
	const projectDir = scratch("gentle-retry-reconnect-default-");
	process.env.GENTLE_PI_CONFIG_HOME = scratch("gentle-retry-reconnect-default-home-");
	writeRetryPolicy("on", projectDir);
	assert.equal(resolveRetryPolicy(projectDir).reconnect, "off");
});

test("the reconnect scope survives a policy rewrite", () => {
	const projectDir = scratch("gentle-retry-reconnect-rewrite-");
	process.env.GENTLE_PI_CONFIG_HOME = scratch("gentle-retry-reconnect-rewrite-home-");
	writeRetryPolicy("on", projectDir, { reconnect: "session" });
	writeRetryPolicy("off", projectDir);
	assert.equal(resolveRetryPolicy(projectDir).reconnect, "session");
});

test("an invalid reconnect scope makes the policy malformed", () => {
	const projectDir = scratch("gentle-retry-reconnect-malformed-");
	process.env.GENTLE_PI_CONFIG_HOME = scratch("gentle-retry-reconnect-malformed-home-");
	const policyDir = join(projectDir, ".pi", "gentle-ai");
	mkdirSync(policyDir, { recursive: true });
	writeFileSync(
		join(policyDir, RETRY_POLICY_FILE),
		JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on", reconnect: "sometimes" }),
	);
	const policy = resolveRetryPolicy(projectDir);
	assert.equal(policy.malformed, true);
	assert.equal(policy.reconnect, "off");
});

test("permanent failures are the ones waiting cannot fix", () => {
	assert.equal(classifyPermanentFailure("Error: insufficient_quota for this organization"), "quota");
	assert.equal(classifyPermanentFailure("Error: 401 unauthorized"), "auth");
	assert.equal(classifyPermanentFailure("Error: 400 Bad Request"), "bad_request");
	assert.equal(
		classifyPermanentFailure("Error: 400 {detail: 'DEGRADED function cannot be invoked'}"),
		undefined,
	);
	assert.equal(classifyPermanentFailure("Error: Request timed out."), undefined);
});
