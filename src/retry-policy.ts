import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";

export const RETRY_POLICY_SCHEMA = "gentle-pi.retry/v1";
export const RETRY_POLICY_FILE = "retry-policy.json";
export const RETRY_POLICY_DEFAULT_BASE_DELAY_MS = 2_000;
export const RETRY_POLICY_DEFAULT_MAX_DELAY_MS = 60_000;

export type RetryPolicyValue = "on" | "off";

export interface RetryPolicyFile {
	schema: string;
	policy: RetryPolicyValue;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

type ReadResult = RetryPolicyFile | { malformed: true } | null;

export interface ResolvedRetryPolicy {
	policy: RetryPolicyValue;
	baseDelayMs: number;
	maxDelayMs: number;
	source: "project_file" | "global_file" | "default";
	malformed?: true;
}

export function gentlePiConfigHome(): string {
	const env = process.env.GENTLE_PI_CONFIG_HOME;
	if (env) return resolve(env);
	return join(homedir(), ".pi", "gentle-ai");
}

function projectRetryPolicyPath(cwd: string): string {
	return join(resolve(cwd), ".pi", "gentle-ai", RETRY_POLICY_FILE);
}

function globalRetryPolicyPath(): string {
	return join(gentlePiConfigHome(), RETRY_POLICY_FILE);
}

function parseRetryPolicyFile(content: string): RetryPolicyFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Object.hasOwn(parsed, "schema") ||
		!Object.hasOwn(parsed, "policy")
	) {
		return null;
	}
	const { schema, policy, baseDelayMs, maxDelayMs, ...rest } = parsed as Record<string, unknown>;
	if (schema !== RETRY_POLICY_SCHEMA) return null;
	if (policy !== "on" && policy !== "off") return null;
	if (Object.keys(rest).length > 0) return null;
	const bd = baseDelayMs as number | undefined;
	const md = maxDelayMs as number | undefined;
	const effectiveBaseDelayMs = bd ?? RETRY_POLICY_DEFAULT_BASE_DELAY_MS;
	const effectiveMaxDelayMs = md ?? RETRY_POLICY_DEFAULT_MAX_DELAY_MS;
	if (!Number.isInteger(effectiveBaseDelayMs) || effectiveBaseDelayMs <= 0) return null;
	if (!Number.isInteger(effectiveMaxDelayMs) || effectiveMaxDelayMs <= 0) return null;
	if (effectiveMaxDelayMs < effectiveBaseDelayMs) return null;
	return { schema, policy: policy as RetryPolicyValue, baseDelayMs: bd, maxDelayMs: md };
}

function readPolicyFile(path: string): ReadResult {
	try {
		const content = readFileSync(path, "utf8");
		const parsed = parseRetryPolicyFile(content);
		if (!parsed) return { malformed: true };
		return parsed;
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return code === "ENOENT" ? null : { malformed: true };
	}
}

export function resolveRetryPolicy(cwd: string): ResolvedRetryPolicy {
	const projectPath = projectRetryPolicyPath(cwd);
	const projectFile = readPolicyFile(projectPath);
	if (projectFile && !("malformed" in projectFile)) {
		return {
			policy: projectFile.policy,
			baseDelayMs: projectFile.baseDelayMs ?? RETRY_POLICY_DEFAULT_BASE_DELAY_MS,
			maxDelayMs: projectFile.maxDelayMs ?? RETRY_POLICY_DEFAULT_MAX_DELAY_MS,
			source: "project_file",
		};
	}
	if (projectFile && "malformed" in projectFile) {
		return {
			policy: "off",
			baseDelayMs: RETRY_POLICY_DEFAULT_BASE_DELAY_MS,
			maxDelayMs: RETRY_POLICY_DEFAULT_MAX_DELAY_MS,
			source: "default",
			malformed: true,
		};
	}
	const globalPath = globalRetryPolicyPath();
	const globalFile = readPolicyFile(globalPath);
	if (globalFile && !("malformed" in globalFile)) {
		return {
			policy: globalFile.policy,
			baseDelayMs: globalFile.baseDelayMs ?? RETRY_POLICY_DEFAULT_BASE_DELAY_MS,
			maxDelayMs: globalFile.maxDelayMs ?? RETRY_POLICY_DEFAULT_MAX_DELAY_MS,
			source: "global_file",
		};
	}
	if (globalFile && "malformed" in globalFile) {
		return {
			policy: "off",
			baseDelayMs: RETRY_POLICY_DEFAULT_BASE_DELAY_MS,
			maxDelayMs: RETRY_POLICY_DEFAULT_MAX_DELAY_MS,
			source: "default",
			malformed: true,
		};
	}
	return {
		policy: "off",
		baseDelayMs: RETRY_POLICY_DEFAULT_BASE_DELAY_MS,
		maxDelayMs: RETRY_POLICY_DEFAULT_MAX_DELAY_MS,
		source: "default",
	};
}

export function writeRetryPolicy(policy: RetryPolicyValue, cwd: string, options?: { baseDelayMs?: number; maxDelayMs?: number; global?: boolean }): void {
	const targetPath = options?.global ? globalRetryPolicyPath() : projectRetryPolicyPath(cwd);
	const dir = dirname(targetPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const current = readPolicyFile(targetPath);
	let baseDelayMs = RETRY_POLICY_DEFAULT_BASE_DELAY_MS;
	let maxDelayMs = RETRY_POLICY_DEFAULT_MAX_DELAY_MS;
	if (current && !("malformed" in current)) {
		baseDelayMs = current.baseDelayMs ?? RETRY_POLICY_DEFAULT_BASE_DELAY_MS;
		maxDelayMs = current.maxDelayMs ?? RETRY_POLICY_DEFAULT_MAX_DELAY_MS;
	}
	if (options?.baseDelayMs !== undefined) baseDelayMs = options.baseDelayMs;
	if (options?.maxDelayMs !== undefined) maxDelayMs = options.maxDelayMs;
	const content = JSON.stringify({ schema: RETRY_POLICY_SCHEMA, policy, baseDelayMs, maxDelayMs }, null, "\t");
	atomicWriteFileSync(targetPath, content, { mode: 0o600 });
}