import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

function openCodeIsAvailable(): { available: true } | { available: false; reason: string } {
	const probe = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 10_000 });
	if (probe.error) {
		const code = (probe.error as NodeJS.ErrnoException).code;
		return { available: false, reason: `OpenCode CLI is unavailable (${code ?? probe.error.message})` };
	}
	if (probe.status !== 0) {
		return {
			available: false,
			reason: `OpenCode CLI version probe exited with status ${probe.status ?? "unknown"}`,
		};
	}
	const version = probe.stdout.trim();
	if (!/^opencode v2\./.test(version)) {
		return { available: false, reason: `OpenCode v2 is required; found ${version || "an unknown version"}` };
	}
	return { available: true };
}

test("OpenCode v2 loads the local package server entrypoint", (t) => {
	const availability = openCodeIsAvailable();
	if (!availability.available) {
		t.skip(availability.reason);
		return;
	}

	const sandbox = mkdtempSync(join(tmpdir(), "gentle-retry-opencode-loader-"));
	const projectDirectory = join(sandbox, "project");
	const homeDirectory = join(sandbox, "home");
	const configDirectory = join(sandbox, "config");
	const dataDirectory = join(sandbox, "data");
	const stateDirectory = join(sandbox, "state");
	const cacheDirectory = join(sandbox, "cache");
	for (const directory of [projectDirectory, homeDirectory, configDirectory, dataDirectory, stateDirectory, cacheDirectory]) {
		mkdirSync(directory, { recursive: true });
	}

	try {
		const relativeRepositoryRoot = relative(projectDirectory, repositoryRoot).split(sep).join("/");
		const pluginPath = relativeRepositoryRoot.startsWith(".")
			? relativeRepositoryRoot
			: `./${relativeRepositoryRoot}`;
		writeFileSync(
			join(projectDirectory, "opencode.json"),
			JSON.stringify({
				"$schema": "https://opencode.ai/config.json",
				plugins: [{
					package: pluginPath,
					options: {
						policy: "on",
						baseDelayMs: 1,
						maxDelayMs: 2,
					},
				}],
			}),
		);

		const result = spawnSync(
			"opencode",
			[
				"run",
				"--standalone",
				"--model",
				"probe/nonexistent",
				"--print-logs",
				"--log-level",
				"debug",
				"gentle-retry loader probe",
			],
			{
				cwd: projectDirectory,
				encoding: "utf8",
				timeout: 30_000,
				env: {
					PATH: process.env.PATH,
					HOME: homeDirectory,
					XDG_CONFIG_HOME: configDirectory,
					XDG_DATA_HOME: dataDirectory,
					XDG_STATE_HOME: stateDirectory,
					XDG_CACHE_HOME: cacheDirectory,
					OPENCODE_DISABLE_AUTOUPDATE: "1",
					OPENCODE_DISABLE_MODELS_FETCH: "1",
					NO_COLOR: "1",
				},
			},
		);
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

		assert.notEqual(result.status, 0, `expected the invalid model to fail; output:\n${output}`);
		assert.match(output, /probe\/nonexistent|model.*not found|provider.*not found/i);
		assert.match(output, /dist\/opencode\.js/);
		assert.doesNotMatch(output, /plugin failed to load|failed to load plugin|error loading plugin/i);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});
