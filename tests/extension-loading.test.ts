import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi's real extension loader accepts the built extension and registers its command", async () => {
	const cwd = resolve(import.meta.dirname, "..");
	const agentDir = mkdtempSync(join(tmpdir(), "gentle-retry-agent-"));
	try {
		const result = await discoverAndLoadExtensions(
			[join(cwd, "dist", "extension.js")],
			cwd,
			agentDir,
			createEventBus(),
		);
		assert.equal(
			result.errors.length,
			0,
			result.errors.map((error) => error.error).join("\n"),
		);
		assert.equal(result.extensions.length, 1);
		assert.ok(result.extensions[0]!.commands.has("gentle:retry"));
		assert.ok(result.extensions[0]!.handlers.has("agent_before_settle"));
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
