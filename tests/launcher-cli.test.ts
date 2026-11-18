import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const binPath = resolve(import.meta.dirname, "..", "bin", "gentle-retry.mjs");
const hasPty = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;

function fixture(t: test.TestContext, autoResume: boolean) {
	const home = mkdtempSync(join(tmpdir(), "gentle-retry-launcher-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const project = join(home, "project");
	const targetDir = join(home, "bin");
	mkdirSync(targetDir, { recursive: true });
	mkdirSync(join(project, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(project, ".pi", "gentle-ai", "retry-policy.json"), JSON.stringify({ schema: "gentle-pi.retry/v1", policy: "on", autoResume }));
	const target = join(targetDir, "gentle-shell");
	writeFileSync(target, `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2) }));\n`);
	chmodSync(target, 0o755);
	const env = { ...process.env, HOME: home, PATH: `${targetDir}:${process.env.PATH ?? ""}` };
	delete env.GENTLE_PI_CONFIG_HOME;
	return { home, project, targetDir, env };
}

test("the real launcher adds --continue for an opted-in ordinary TTY launch", { skip: !hasPty && "needs python3 pty" }, (t) => {
	const f = fixture(t, true);
	const python = [
		"import os, pty, sys",
		`env = dict(os.environ); env['HOME'] = ${JSON.stringify(f.home)}`,
		`os.chdir(${JSON.stringify(f.project)})`,
		`pty.spawn([${JSON.stringify(process.execPath)}, ${JSON.stringify(binPath)}, 'launch', '--target', 'gentle-shell'], lambda fd: os.read(fd, 1024))`,
	].join("\n");
	const result = spawnSync("python3", ["-c", python], { env: f.env, encoding: "utf8", timeout: 15000 });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /\{"args":\["--continue"\]\}/);
});

test("the real launcher preserves explicit arguments and disabled auto-resume", (t) => {
	for (const autoResume of [true, false]) {
		const f = fixture(t, autoResume);
		const args = autoResume ? ["--session", "chosen"] : [];
		const result = spawnSync(process.execPath, [binPath, "launch", "--target", "gentle-shell", "--", ...args], {
			cwd: f.project, env: f.env, encoding: "utf8", timeout: 15000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { args });
	}
});
