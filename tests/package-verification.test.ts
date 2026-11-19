import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifyPackedArtifact } from "../scripts/verify-package.mjs";

function createPackedFixture({
	includeMetadata = true,
	includeInstallCommand = true,
	includeServerExport = true,
	includeServerTypes = true,
	includeBin = true,
	launcherMode = 0o755,
	includePrepare = true,
	defaultExport = "export default function gentleRetryExtension() {}",
	serverDefaultExport = "export default { id: \"gentle-retry\", setup() {} };",
} = {}) {
	const fixtureDirectory = mkdtempSync(join(tmpdir(), "gentle-retry-fixture-"));
	const packageDirectory = join(fixtureDirectory, "package");
	const extensionDirectory = join(packageDirectory, "dist");
	mkdirSync(extensionDirectory, { recursive: true });
	mkdirSync(join(packageDirectory, "bin"), { recursive: true });

	writeFileSync(
		join(packageDirectory, "package.json"),
		JSON.stringify({
			name: "gentle-retry",
			version: "0.1.0",
			type: "module",
			pi: includeMetadata ? { extensions: ["./dist/extension.js"] } : { extensions: [] },
			...(includeBin ? { bin: { "gentle-retry": "./bin/gentle-retry.mjs" } } : {}),
			...(includePrepare ? { scripts: { prepare: "pnpm run build" } } : {}),
			exports: {
				".": {
					types: "./dist/index.d.ts",
					import: "./dist/index.js",
				},
				...(includeServerExport
					? {
						"./server": {
							...(includeServerTypes ? { types: "./dist/opencode.d.ts" } : {}),
							import: "./dist/opencode.js",
						},
					}
					: {}),
			},
		}),
	);
	writeFileSync(join(extensionDirectory, "extension.js"), `${defaultExport}\n`);
	writeFileSync(join(packageDirectory, "bin", "gentle-retry.mjs"), "#!/usr/bin/env node\nif (process.argv.includes('--help')) console.log('Usage: gentle-retry');\n");
	chmodSync(join(packageDirectory, "bin", "gentle-retry.mjs"), launcherMode);
	writeFileSync(join(extensionDirectory, "launcher.js"), "export const buildLaunchPlan = () => {}; export const resolveLaunchCommand = () => {};\n");
	writeFileSync(join(extensionDirectory, "retry-policy.js"), "export const resolveRetryPolicy = () => ({ autoResume: false });\n");
	writeFileSync(join(extensionDirectory, "shell-integration.js"), "export const installShellIntegration = () => {}; export const removeShellIntegration = () => {};\n");
	writeFileSync(join(extensionDirectory, "index.d.ts"), "export default () => void;\n");
	writeFileSync(join(extensionDirectory, "opencode.js"), `${serverDefaultExport}\n`);
	writeFileSync(join(extensionDirectory, "opencode.d.ts"), "export default { id: string; setup(): void };\n");
	writeFileSync(
		join(packageDirectory, "README.md"),
		includeInstallCommand ? "Install with:\n\npi install npm:gentle-retry\n\nnpx --yes https://github.com/andrikonbeat/gentle-retry\n" : "Install with:\n\npi install gentle-retry\n",
	);

	const tarballPath = join(fixtureDirectory, "gentle-retry-0.1.0.tgz");
	execFileSync("tar", ["-czf", tarballPath, "-C", fixtureDirectory, "package"]);
	return { fixtureDirectory, tarballPath };
}

test("verifies both public entrypoints, metadata, and install command in a packed artifact", async () => {
	const fixture = createPackedFixture();
	try {
		const result = await verifyPackedArtifact(fixture.tarballPath);
		assert.equal(result.packageName, "gentle-retry");
		assert.equal(result.packageVersion, "0.1.0");
		assert.equal(result.extensionPath, "./dist/extension.js");
		assert.equal(result.defaultExportType, "function");
		assert.equal(result.openCodePath, "./dist/opencode.js");
		assert.equal(result.openCodeId, "gentle-retry");
		assert.equal(result.openCodeSetupType, "function");
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects a packed artifact without the launcher command", async () => {
	const fixture = createPackedFixture({ includeBin: false });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /missing.*bin|launcher command/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects a package that cannot build during a fresh Git installation", async () => {
	const fixture = createPackedFixture({ includePrepare: false });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /prepare/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects a packed launcher that is not executable", async () => {
	const fixture = createPackedFixture({ launcherMode: 0o644 });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /not executable/);
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
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /dist\/extension\.js default export is not a function/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects a packed artifact without the OpenCode server export", async () => {
	const fixture = createPackedFixture({ includeServerExport: false });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /missing \.\/server package export/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects an OpenCode server export without matching types", async () => {
	const fixture = createPackedFixture({ includeServerTypes: false });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /missing types for \.\/server package export/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects an OpenCode server default export that is not an object", async () => {
	const fixture = createPackedFixture({ serverDefaultExport: "export default function opencodePlugin() {}" });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /dist\/opencode\.js default export is not an object/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects an OpenCode server default export without a stable string id", async () => {
	const fixture = createPackedFixture({ serverDefaultExport: "export default { id: 42, setup() {} };" });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /stable string id/);
	} finally {
		rmSync(fixture.fixtureDirectory, { recursive: true, force: true });
	}
});

test("rejects an OpenCode server default export without a setup function", async () => {
	const fixture = createPackedFixture({ serverDefaultExport: "export default { id: \"gentle-retry\" };" });
	try {
		await assert.rejects(verifyPackedArtifact(fixture.tarballPath), /setup function/);
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
