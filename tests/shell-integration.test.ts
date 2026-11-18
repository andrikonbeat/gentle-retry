import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
			const url = new URL(specifier, context.parentURL);
			url.pathname = `${url.pathname.slice(0, -3)}.ts`;
			return { url: url.href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

const { installShellIntegration, removeShellIntegration } = await import("../src/shell-integration.ts");

function scratch(t: test.TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "gentle-retry-shell-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return home;
}

test("shell integration is idempotent, backed up and removable without touching user content", (t) => {
	const home = scratch(t);
	const file = join(home, ".bashrc");
	writeFileSync(file, "export KEEP=1\n");
	const first = installShellIntegration({ homeDir: home, shell: "bash", target: "gentle-shell" });
	assert.equal(first.changed, true);
	assert.equal(readFileSync(first.backupPath, "utf8"), "export KEEP=1\n");
	const integrated = readFileSync(file, "utf8");
	assert.match(integrated, /export KEEP=1/);
	assert.match(integrated, /gentle-shell\(\) \{\n  command gentle-retry launch --target gentle-shell -- "\$@"/);
	assert.equal(installShellIntegration({ homeDir: home, shell: "bash", target: "gentle-shell" }).changed, false);
	assert.equal(readFileSync(file, "utf8"), integrated);
	assert.equal(removeShellIntegration({ homeDir: home, shell: "bash" }).changed, true);
	assert.equal(readFileSync(file, "utf8"), "export KEEP=1\n");
	assert.equal(readFileSync(first.backupPath, "utf8"), "export KEEP=1\n");
});

test("a malformed existing marker fails closed without changing the shell file", (t) => {
	const home = scratch(t);
	const file = join(home, ".bashrc");
	writeFileSync(file, "# >>> gentle-retry auto-resume >>>\nexport KEEP=1\n");
	assert.throws(() => installShellIntegration({ homeDir: home, shell: "bash", target: "gentle-shell" }), /marker/i);
	assert.equal(readFileSync(file, "utf8"), "# >>> gentle-retry auto-resume >>>\nexport KEEP=1\n");
});

test("zsh integration supports Pi and creates only the selected shell file", (t) => {
	const home = scratch(t);
	const result = installShellIntegration({ homeDir: home, shell: "zsh", target: "pi" });
	assert.equal(result.path, join(home, ".zshrc"));
	assert.match(readFileSync(result.path, "utf8"), /command gentle-retry launch --target pi --/);
	assert.equal(removeShellIntegration({ homeDir: home, shell: "zsh" }).changed, true);
	assert.equal(readFileSync(result.path, "utf8"), "");
});
