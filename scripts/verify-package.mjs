#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_EXPORT_PATH = "./dist/index.js";
const ROOT_TYPES_PATH = "./dist/index.d.ts";
const EXTENSION_PATH = "./dist/extension.js";
const OPENCODE_PATH = "./dist/opencode.js";
const OPENCODE_TYPES_PATH = "./dist/opencode.d.ts";
const OPENCODE_PLUGIN_ID = "gentle-retry";
const LAUNCHER_PATH = "./bin/gentle-retry.mjs";
const INSTALL_COMMAND = "pi install npm:gentle-retry";
const GITHUB_SETUP_COMMAND = "npx --yes https://github.com/andrikonbeat/gentle-retry";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function assertExtensionMetadata(packageJson) {
	const extensions = packageJson?.pi?.extensions;
	if (!Array.isArray(extensions) || !extensions.includes(EXTENSION_PATH)) {
		throw new Error(`packed package is missing pi.extensions metadata for ${EXTENSION_PATH}`);
	}
}

export function assertPackageExports(packageJson) {
	const rootExport = packageJson?.exports?.["."];
	if (
		typeof rootExport !== "object" ||
		rootExport === null ||
		rootExport.import !== ROOT_EXPORT_PATH ||
		rootExport.types !== ROOT_TYPES_PATH
	) {
		throw new Error(`packed package is missing the root export for ${ROOT_EXPORT_PATH}`);
	}

	const serverExport = packageJson?.exports?.["./server"];
	if (typeof serverExport !== "object" || serverExport === null) {
		throw new Error("packed package is missing ./server package export");
	}
	if (serverExport.import !== OPENCODE_PATH) {
		throw new Error(`packed ./server package export must point to ${OPENCODE_PATH}`);
	}
	if (serverExport.types !== OPENCODE_TYPES_PATH) {
		throw new Error(`packed package is missing types for ./server package export (${OPENCODE_TYPES_PATH})`);
	}
}

export function assertLauncherCommand(packageJson) {
	if (packageJson?.bin?.["gentle-retry"] !== LAUNCHER_PATH) {
		throw new Error(`packed package is missing the launcher command bin entry for ${LAUNCHER_PATH}`);
	}
	if (typeof packageJson?.scripts?.prepare !== "string" || !/(?:build|tsc)/.test(packageJson.scripts.prepare)) {
		throw new Error("packed package is missing the prepare build required for a fresh Git installation");
	}
}

export function assertDefaultExport(extensionModule) {
	if (typeof extensionModule?.default !== "function") {
		throw new Error("packed dist/extension.js default export is not a function");
	}
}

export function assertOpenCodePlugin(openCodeModule) {
	const plugin = openCodeModule?.default;
	if (typeof plugin !== "object" || plugin === null || Array.isArray(plugin)) {
		throw new Error("packed dist/opencode.js default export is not an object");
	}
	if (typeof plugin.id !== "string" || plugin.id !== OPENCODE_PLUGIN_ID) {
		throw new Error(`packed dist/opencode.js default export must have a stable string id (${OPENCODE_PLUGIN_ID})`);
	}
	if (typeof plugin.setup !== "function") {
		throw new Error("packed dist/opencode.js default export must have a setup function");
	}
	return plugin;
}

export function assertInstallCommand(readme) {
	const commands = readme.split(/\r?\n/).map((line) => line.trim());
	if (!commands.includes(INSTALL_COMMAND)) {
		throw new Error(`packed public instructions are missing the exact command: ${INSTALL_COMMAND}`);
	}
	if (!commands.includes(GITHUB_SETUP_COMMAND)) {
		throw new Error(`packed public instructions are missing the exact command: ${GITHUB_SETUP_COMMAND}`);
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
		assertPackageExports(packageJson);
		assertLauncherCommand(packageJson);
		const launcherPath = join(extractionDirectory, "bin", "gentle-retry.mjs");
		if (!existsSync(launcherPath)) {
			throw new Error(`packed package is missing the launcher executable: ${LAUNCHER_PATH}`);
		}
		if (process.platform !== "win32" && (statSync(launcherPath).mode & 0o111) === 0) {
			throw new Error("packed launcher is not executable");
		}
		const help = execFileSync(process.execPath, [launcherPath, "--help"], { encoding: "utf8" });
		if (!help.includes("Usage:")) throw new Error("packed launcher could not load and print its help");

		const rootTypesPath = join(extractionDirectory, "dist", "index.d.ts");
		const serverTypesPath = join(extractionDirectory, "dist", "opencode.d.ts");
		if (!existsSync(rootTypesPath)) {
			throw new Error(`packed package is missing root types: ${ROOT_TYPES_PATH}`);
		}
		if (!existsSync(serverTypesPath)) {
			throw new Error(`packed package is missing server types: ${OPENCODE_TYPES_PATH}`);
		}

		const readme = readFileSync(join(extractionDirectory, "README.md"), "utf8");
		assertInstallCommand(readme);

		const extensionPath = join(extractionDirectory, "dist", "extension.js");
		const extensionModule = await import(pathToFileURL(extensionPath).href);
		assertDefaultExport(extensionModule);

		const openCodePath = join(extractionDirectory, "dist", "opencode.js");
		const openCodeModule = await import(pathToFileURL(openCodePath).href);
		const openCodePlugin = assertOpenCodePlugin(openCodeModule);

		return {
			packageName: packageJson.name,
			packageVersion: packageJson.version,
			extensionPath: EXTENSION_PATH,
			defaultExportType: typeof extensionModule.default,
			openCodePath: OPENCODE_PATH,
			openCodeId: openCodePlugin.id,
			openCodeSetupType: typeof openCodePlugin.setup,
			launcherPath: LAUNCHER_PATH,
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
		console.log(`OpenCode server: ${result.openCodePath} (${result.openCodeId})`);
		console.log(`Launcher command: ${result.launcherPath}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
