import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRetryPolicy, writeRetryPolicy, RETRY_POLICY_SCHEMA, RETRY_POLICY_FILE } from "../dist/retry-policy.js";

function isolatedConfigHome(): string {
	const home = mkdtempSync(join(tmpdir(), "gentle-retry-config-"));
	return home;
}

function safeRm(path: string): void {
	try { rmSync(path, { recursive: true, force: true }); } catch {}
}

function isolatedProject(cwd: string): void {
	process.chdir(cwd);
}

test("retry policy defaults off, persists strictly, and fails closed on malformed input", () => {
	const configHome = isolatedConfigHome();
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-proj-"));
	isolatedProject(projectDir);
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	const policy = resolveRetryPolicy(projectDir);
	assert.equal(policy.policy, "off");
	assert.equal(policy.source, "default");
	safeRm(projectDir);
});

test("malformed global retry files fall back to off without being rewritten", () => {
	const configHome = isolatedConfigHome();
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-proj-"));
	isolatedProject(projectDir);
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), "{ not valid json }");
	const policy = resolveRetryPolicy(projectDir);
	assert.equal(policy.policy, "off");
	assert.equal(policy.source, "default");
	assert.ok(policy.malformed);
	safeRm(projectDir);
});

test("an unreadable retry file fails closed instead of enabling the retry loop", () => {
	const configHome = isolatedConfigHome();
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-proj-"));
	isolatedProject(projectDir);
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	const file = join(configHome, RETRY_POLICY_FILE);
	writeFileSync(file, JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on" }));
	const dir = join(configHome, "subdir");
	// Make file unreadable by removing read permission
	try { rmSync(file); } catch {}
	mkdirSync(dir, { mode: 0o000 });
	const policy = resolveRetryPolicy(projectDir);
	assert.equal(policy.policy, "off");
	safeRm(projectDir);
});

test("a project retry file overrides the global one", () => {
	const configHome = isolatedConfigHome();
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-proj-"));
	isolatedProject(projectDir);
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "off" }));
	mkdirSync(join(projectDir, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "gentle-ai", RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on" }));
	const policy = resolveRetryPolicy(projectDir);
	assert.equal(policy.policy, "on");
	assert.equal(policy.source, "project_file");
	safeRm(projectDir);
});

test("a malformed project retry file fails closed even when the global one is on", () => {
	const configHome = isolatedConfigHome();
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-proj-"));
	isolatedProject(projectDir);
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on", baseDelayMs: 1000 }));
	mkdirSync(join(projectDir, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(projectDir, ".pi", "gentle-ai", RETRY_POLICY_FILE), "{ invalid }");
	const policy = resolveRetryPolicy(projectDir);
	assert.equal(policy.policy, "off");
	assert.equal(policy.source, "default");
	assert.ok(policy.malformed);
	safeRm(projectDir);
});

test("delay knobs are optional, defaulted, and survive a policy switch", () => {
	const configHome = isolatedConfigHome();
	const projectDir = mkdtempSync(join(tmpdir(), "gentle-retry-proj-"));
	isolatedProject(projectDir);
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeRetryPolicy("on", projectDir, { baseDelayMs: 3000, maxDelayMs: 90000 });
	let policy = resolveRetryPolicy(projectDir);
	assert.equal(policy.baseDelayMs, 3000);
	assert.equal(policy.maxDelayMs, 90000);
	writeRetryPolicy("off", projectDir);
	policy = resolveRetryPolicy(projectDir);
	assert.equal(policy.policy, "off");
	assert.equal(policy.baseDelayMs, 3000);
	assert.equal(policy.maxDelayMs, 90000);
	safeRm(projectDir);
});