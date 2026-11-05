import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

// Run the focused tests against TypeScript sources without writing build output
// outside the task's allowed edit surfaces. The published build still uses the
// conventional .js specifiers.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const {
	resolveRetryPolicy,
	writeRetryPolicy,
	RETRY_POLICY_SCHEMA,
	RETRY_POLICY_FILE,
} = await import("../src/retry-policy.ts");

const scratchDirectories: string[] = [];
const originalConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
const originalTmpDir = process.env.TMPDIR;

afterEach(() => {
	if (originalConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = originalConfigHome;
	if (originalTmpDir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpDir;
	for (const directory of scratchDirectories.splice(0).reverse()) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {}
	}
});

function scratch(prefix: string, root = tmpdir()): string {
	const directory = mkdtempSync(join(root, prefix));
	scratchDirectories.push(directory);
	return directory;
}

function writePolicyFile(path: string, value: Record<string, unknown>): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

test("retry policy defaults off when neither project nor global policy exists", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
	process.env.GENTLE_PI_CONFIG_HOME = configHome;

	const policy = resolveRetryPolicy(projectDir);

	assert.equal(policy.policy, "off");
	assert.equal(policy.source, "default");
});

test("malformed global retry files fall back to off without being rewritten", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), "{ not valid json }");

	const policy = resolveRetryPolicy(projectDir);

	assert.equal(policy.policy, "off");
	assert.equal(policy.source, "default");
	assert.ok(policy.malformed);
});

test("an unreadable project retry file fails closed instead of enabling from global", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on" }));
	const projectPolicyDir = join(projectDir, ".pi", "gentle-ai");
	mkdirSync(projectPolicyDir, { recursive: true });
	// A directory at the file path is unreadable on Linux without relying on
	// root bypassing file permission bits.
	mkdirSync(join(projectPolicyDir, RETRY_POLICY_FILE));

	const policy = resolveRetryPolicy(projectDir);

	assert.equal(policy.policy, "off");
	assert.equal(policy.source, "default");
	assert.ok(policy.malformed);
});

test("a missing project retry file permits an enabled global policy", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on" }));

	const policy = resolveRetryPolicy(projectDir);

	assert.equal(policy.policy, "on");
	assert.equal(policy.source, "global_file");
});

test("a project retry file overrides the global one", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "off" }));
	writePolicyFile(join(projectDir, ".pi", "gentle-ai", RETRY_POLICY_FILE), {
		schema: RETRY_POLICY_SCHEMA,
		policy: "on",
	});

	const policy = resolveRetryPolicy(projectDir);

	assert.equal(policy.policy, "on");
	assert.equal(policy.source, "project_file");
});

test("a malformed project retry file fails closed even when the global one is on", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on", baseDelayMs: 1000 }));
	const projectPolicyPath = join(projectDir, ".pi", "gentle-ai", RETRY_POLICY_FILE);
	mkdirSync(join(projectPolicyPath, ".."), { recursive: true });
	writeFileSync(projectPolicyPath, "{ invalid }");

	const policy = resolveRetryPolicy(projectDir);

	assert.equal(policy.policy, "off");
	assert.equal(policy.source, "default");
	assert.ok(policy.malformed);
});

test("an unknown-schema project retry file fails closed even when the global one is on", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writeFileSync(join(configHome, RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on" }));
	writePolicyFile(join(projectDir, ".pi", "gentle-ai", RETRY_POLICY_FILE), {
		schema: "gentle-pi.retry/unknown",
		policy: "on",
	});

	const policy = resolveRetryPolicy(projectDir);

	assert.equal(policy.policy, "off");
	assert.equal(policy.source, "default");
	assert.ok(policy.malformed);
});

test("delay knobs are optional, defaulted, and survive a policy switch", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
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
});

for (const [name, delays] of [
	["a zero base delay", { baseDelayMs: 0, maxDelayMs: 1000 }],
	["a zero maximum delay", { baseDelayMs: 1000, maxDelayMs: 0 }],
	["an inverted delay range", { baseDelayMs: 2000, maxDelayMs: 1000 }],
] as const) {
	test(`${name} makes the project policy malformed and fails closed`, () => {
		const configHome = scratch("gentle-retry-config-");
		const projectDir = scratch("gentle-retry-project-");
		process.env.GENTLE_PI_CONFIG_HOME = configHome;
		writeFileSync(join(configHome, RETRY_POLICY_FILE), JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy: "on" }));
		writePolicyFile(join(projectDir, ".pi", "gentle-ai", RETRY_POLICY_FILE), {
			schema: RETRY_POLICY_SCHEMA,
			policy: "on",
			...delays,
		});

		const policy = resolveRetryPolicy(projectDir);

		assert.equal(policy.policy, "off");
		assert.equal(policy.source, "default");
		assert.ok(policy.malformed);
	});
}

test("positive integer delays with max greater than or equal to base are accepted", () => {
	const configHome = scratch("gentle-retry-config-");
	const projectDir = scratch("gentle-retry-project-");
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	writePolicyFile(join(projectDir, ".pi", "gentle-ai", RETRY_POLICY_FILE), {
		schema: RETRY_POLICY_SCHEMA,
		policy: "on",
		baseDelayMs: 1000,
		maxDelayMs: 1000,
	});

	const policy = resolveRetryPolicy(projectDir);

	assert.equal(policy.policy, "on");
	assert.equal(policy.baseDelayMs, 1000);
	assert.equal(policy.maxDelayMs, 1000);
});

test("project and global policy writes work across filesystems from the OS temporary directory", () => {
	const configHome = scratch("gentle-retry-config-", homedir());
	const projectDir = scratch("gentle-retry-project-", homedir());
	const globalProjectDir = scratch("gentle-retry-global-project-", homedir());
	const operatingSystemTemp = scratch("gentle-retry-os-temp-", tmpdir());
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	assert.notEqual(
		statSync(projectDir).dev,
		statSync(operatingSystemTemp).dev,
		"the regression requires project and OS temporary paths on different filesystems",
	);
	process.env.TMPDIR = operatingSystemTemp;

	writeRetryPolicy("on", projectDir, { baseDelayMs: 3000, maxDelayMs: 90000 });
	const projectPolicy = resolveRetryPolicy(projectDir);
	assert.equal(projectPolicy.policy, "on");
	assert.equal(projectPolicy.source, "project_file");
	assert.equal(projectPolicy.baseDelayMs, 3000);
	assert.equal(projectPolicy.maxDelayMs, 90000);

	writeRetryPolicy("on", globalProjectDir, { global: true });
	const globalPolicy = resolveRetryPolicy(globalProjectDir);
	assert.equal(globalPolicy.policy, "on");
	assert.equal(globalPolicy.source, "global_file");
});
