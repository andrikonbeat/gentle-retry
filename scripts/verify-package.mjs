#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_PATH = "./dist/extension.js";
const INSTALL_COMMAND = "pi install npm:gentle-retry";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function assertExtensionMetadata(packageJson) {
	const extensions = packageJson?.pi?.extensions;
	if (!Array.isArray(extensions) || !extensions.includes(EXTENSION_PATH)) {
		throw new Error(`packed package is missing pi.extensions metadata for ${EXTENSION_PATH}`);
	}
}

export function assertDefaultExport(extensionModule) {
	if (typeof extensionModule?.default !== "function") {
		throw new Error("packed dist/extension.js default export is not a function");
	}
}

export function assertInstallCommand(readme) {
	const commands = readme.split(/\r?\n/).map((line) => line.trim());
	if (!commands.includes(INSTALL_COMMAND)) {
		throw new Error(`packed public instructions are missing the exact command: ${INSTALL_COMMAND}`);
	}
}

function packRootPackage(rootDirectory, destinationDirectory) {
	// The release gate builds first; skipping lifecycle scripts keeps this
	// verifier deterministic and prevents it from rebuilding the artifact twice.
	const output = execFileSync(
		"npm",
		["pack", "--json", "--offline", "--ignore-scripts", "--pack-destination", destinationDirectory],
		{
			cwd: rootDirectory,
			encoding: "utf8",
			env: {
				...process.env,
				npm_config_audit: "false",
				npm_config_fund: "false",
				npm_config_update_notifier: "false",
			},
		},
	);
	const filename = output.match(/"filename"\s*:\s*"([^"]+)"/)?.[1];
	if (!filename || basename(filename) !== filename) {
		throw new Error("npm pack did not report a valid tarball filename");
	}
	return join(destinationDirectory, filename);
}

export async function verifyPackedArtifact(tarballPath) {
	const extractionDirectory = mkdtempSync(join(tmpdir(), "gentle-retry-package-"));
	try {
		execFileSync("tar", ["-xzf", tarballPath, "-C", extractionDirectory, "--strip-components=1"]);
		const packageJson = JSON.parse(readFileSync(join(extractionDirectory, "package.json"), "utf8"));
		assertExtensionMetadata(packageJson);

		const readme = readFileSync(join(extractionDirectory, "README.md"), "utf8");
		assertInstallCommand(readme);

		const extensionPath = join(extractionDirectory, "dist", "extension.js");
		const extensionModule = await import(pathToFileURL(extensionPath).href);
		assertDefaultExport(extensionModule);

		return {
			packageName: packageJson.name,
			packageVersion: packageJson.version,
			extensionPath: EXTENSION_PATH,
			defaultExportType: typeof extensionModule.default,
		};
	} finally {
		rmSync(extractionDirectory, { recursive: true, force: true });
	}
}

export async function packAndVerifyPackage(rootDirectory = repositoryRoot) {
	const packDirectory = mkdtempSync(join(tmpdir(), "gentle-retry-pack-"));
	try {
		const tarballPath = packRootPackage(rootDirectory, packDirectory);
		return await verifyPackedArtifact(tarballPath);
	} finally {
		rmSync(packDirectory, { recursive: true, force: true });
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
	try {
		const result = await packAndVerifyPackage();
		console.log(`Verified packed artifact: ${result.packageName}@${result.packageVersion}`);
		console.log(`Extension metadata: ${result.extensionPath}`);
		console.log(`Default export: ${result.defaultExportType}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
