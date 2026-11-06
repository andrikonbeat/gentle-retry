import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyPackedArtifact } from "../scripts/verify-package.mjs";

function createPackedFixture({
	includeMetadata = true,
	includeInstallCommand = true,
	defaultExport = "export default function gentleRetryExtension() {}",
} = {}) {
	const fixtureDirectory = mkdtempSync(join(tmpdir(), "gentle-retry-fixture-"));
	const packageDirectory = join(fixtureDirectory, "package");
	const extensionDirectory = join(packageDirectory, "dist");
	mkdirSync(extensionDirectory, { recursive: true });

	writeFileSync(
		join(packageDirectory, "package.json"),
		JSON.stringify({
			name: "gentle-retry",
			version: "0.1.0",
			type: "module",
			pi: includeMetadata ? { extensions: ["./dist/extension.js"] } : { extensions: [] },
		}),
	);
	writeFileSync(join(extensionDirectory, "extension.js"), `${defaultExport}\n`);
	writeFileSync(
		join(packageDirectory, "README.md"),
		includeInstallCommand ? "Install with:\n\npi install npm:gentle-retry\n" : "Install with:\n\npi install gentle-retry\n",
	);

	const tarballPath = join(fixtureDirectory, "gentle-retry-0.1.0.tgz");
	execFileSync("tar", ["-czf", tarballPath, "-C", fixtureDirectory, "package"]);
	return { fixtureDirectory, tarballPath };
}

test("verifies extension metadata, default export, and install command in a packed artifact", async () => {
	const fixture = createPackedFixture();
	try {
		const result = await verifyPackedArtifact(fixture.tarballPath);
		assert.equal(result.packageName, "gentle-retry");
		assert.equal(result.packageVersion, "0.1.0");
		assert.equal(result.extensionPath, "./dist/extension.js");
		assert.equal(result.defaultExportType, "function");
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects a packed artifact without extension metadata", async () => {
	const fixture = createPackedFixture({ includeMetadata: false });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /missing pi\.extensions metadata/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects a packed extension whose default export is not a function", async () => {
	const fixture = createPackedFixture({ defaultExport: "export default 42;" });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /default export is not a function/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects packed public instructions with a different install command", async () => {
	const fixture = createPackedFixture({ includeInstallCommand: false });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /missing the exact command/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});
