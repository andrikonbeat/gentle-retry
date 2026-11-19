import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const binPath = resolve(import.meta.dirname, "..", "bin", "gentle-retry.mjs");

function fixture(t: test.TestContext, options: { npmStatus?: number; piStatus?: number } = {}) {
	const home = mkdtempSync(join(tmpdir(), "gentle-retry-setup-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const project = join(home, "project");
	const bin = join(home, "bin");
	const log = join(home, "calls.jsonl");
	mkdirSync(project, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(home, ".bashrc"), "export KEEP=1\n");
	for (const [name, status] of [["npm", options.npmStatus ?? 0], ["pi", options.piStatus ?? 0], ["gentle-shell", 0]] as const) {
		writeFileSync(join(bin, name), `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, args }) + '\\n');\nif (args[0] === 'root') console.log(process.env.HOME + '/global');\nprocess.exit(${status});\n`);
		chmodSync(join(bin, name), 0o755);
	}
	const env = { ...process.env, HOME: home, SHELL: "/bin/bash", PATH: `${bin}:${process.env.PATH ?? ""}` };
	delete env.GENTLE_PI_CONFIG_HOME;
	return { home, project, log, env };
}

function setup(f: ReturnType<typeof fixture>) {
	return spawnSync(process.execPath, [binPath, "setup", "--source", "/fixture/gentle-retry", "--target", "gentle-shell", "--shell", "bash"], {
		cwd: f.project, env: f.env, encoding: "utf8", timeout: 15000,
	});
}

test("one-command setup installs both packages before adding an idempotent removable shell block", (t) => {
	const f = fixture(t);
	const first = setup(f);
	assert.equal(first.status, 0, first.stderr);
	const calls = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(calls, [
		{ name: "npm", args: ["install", "--global", "/fixture/gentle-retry"] },
		{ name: "pi", args: ["install", "/fixture/gentle-retry"] },
	]);
	const file = join(f.home, ".bashrc");
	const integrated = readFileSync(file, "utf8");
	assert.match(integrated, /export KEEP=1/);
	assert.match(integrated, /gentle-shell\(\)/);
	assert.equal(setup(f).status, 0);
	assert.equal(readFileSync(file, "utf8"), integrated);
	const removed = spawnSync(process.execPath, [binPath, "uninstall", "--shell", "bash"], { cwd: f.project, env: f.env, encoding: "utf8" });
	assert.equal(removed.status, 0, removed.stderr);
	assert.equal(readFileSync(file, "utf8"), "export KEEP=1\n");
});

test("the public command uses a tarball and registers Pi from the global package without Git", (t) => {
	const f = fixture(t);
	const result = spawnSync(process.execPath, [binPath], { cwd: f.project, env: f.env, encoding: "utf8", timeout: 15000 });
	assert.equal(result.status, 0, result.stderr);
	const calls = readFileSync(f.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(calls, [
		{ name: "npm", args: ["install", "--global", "https://github.com/andrikonbeat/gentle-retry/releases/latest/download/gentle-retry.tgz"] },
		{ name: "npm", args: ["root", "--global"] },
		{ name: "pi", args: ["install", join(f.home, "global", "gentle-retry")] },
	]);
});

test("an unset or empty SHELL falls back to Bash before changing any package", (t) => {
	const f = fixture(t);
	f.env.SHELL = "";
	const result = spawnSync(process.execPath, [binPath], { cwd: f.project, env: f.env, encoding: "utf8", timeout: 15000 });
	assert.equal(result.status, 0, result.stderr);
	assert.match(readFileSync(join(f.home, ".bashrc"), "utf8"), /gentle-retry auto-resume/);
});

test("Fish uses config.fish and its native function syntax", (t) => {
	const f = fixture(t);
	f.env.SHELL = "/bin/fish";
	const result = spawnSync(process.execPath, [binPath], { cwd: f.project, env: f.env, encoding: "utf8", timeout: 15000 });
	assert.equal(result.status, 0, result.stderr);
	const config = join(f.home, ".config", "fish", "config.fish");
	assert.match(readFileSync(config, "utf8"), /function gentle-shell\n  command gentle-retry launch --target gentle-shell -- \$argv\nend/);
});

test("a failed global or Pi installation leaves shell startup unchanged", (t) => {
	for (const failure of ["npm", "pi"] as const) {
		const f = fixture(t, failure === "npm" ? { npmStatus: 1 } : { piStatus: 1 });
		const result = setup(f);
		assert.equal(result.status, 1);
		assert.equal(readFileSync(join(f.home, ".bashrc"), "utf8"), "export KEEP=1\n");
		const calls = existsSync(f.log) ? readFileSync(f.log, "utf8") : "";
		assert.equal(calls.includes('"name":"pi"'), failure !== "npm");
	}
});
