#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { constants as osConstants, homedir } from "node:os";
import { buildLaunchPlan, resolveLaunchCommand } from "../dist/launcher.js";
import { resolveRetryPolicy } from "../dist/retry-policy.js";
import { installShellIntegration, removeShellIntegration } from "../dist/shell-integration.js";

const DEFAULT_SOURCE = "https://github.com/andrikonbeat/gentle-retry/releases/latest/download/gentle-retry.tgz";

function help() {
	return [
		"gentle-retry",
		"",
		"Usage:",
		"  gentle-retry [setup] [--source <package>] [--target auto|gentle-shell|pi] [--shell bash|zsh|fish]",
		"  gentle-retry launch [--target auto|gentle-shell|pi] [--] [Pi arguments]",
		"  gentle-retry uninstall [--shell bash|zsh|fish]",
		"",
		"Setup installs the global command and Pi extension, then integrates the selected shell.",
		"An ordinary interactive launch adds --continue only when gentle-retry autoResume is enabled.",
		"Explicit arguments and noninteractive launches are forwarded unchanged.",
	].join("\n");
}

function exitForResult(result) {
	if (result.error) {
		console.error(`gentle-retry: ${result.error.message}`);
		return 1;
	}
	if (result.signal) return 128 + (osConstants.signals[result.signal] ?? 0);
	return result.status ?? 1;
}

function parseOptions(argv, allowed) {
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const key = argv[index];
		if (!allowed.includes(key)) throw new Error(`unknown option: ${key}`);
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value`);
		values[key] = value;
		index += 1;
	}
	return values;
}

function run(command, args) {
	return exitForResult(spawnSync(command, args, { stdio: "inherit", env: process.env }));
}

function globalPiPackagePath() {
	const result = spawnSync("npm", ["root", "--global"], { encoding: "utf8", env: process.env });
	if (result.error || result.status !== 0 || !result.stdout.trim()) {
		throw new Error(result.error?.message ?? "npm root --global failed");
	}
	return join(result.stdout.trim(), "gentle-retry");
}

function replaceLegacyPiDeclaration() {
	const result = spawnSync("pi", ["list"], { encoding: "utf8", env: process.env });
	if (result.error || result.status !== 0) {
		console.error(`gentle-retry: could not inspect Pi packages${result.error ? ` (${result.error.message})` : ""}`);
		return 1;
	}
	if (!/^npm:gentle-retry\s*$/m.test(result.stdout)) return 0;
	return run("pi", ["remove", "npm:gentle-retry"]);
}

function selectedShell(value) {
	const shell = value ?? basename(process.env.SHELL || "bash");
	if (shell !== "bash" && shell !== "zsh" && shell !== "fish") throw new Error("shell integration supports bash, zsh, and fish");
	return shell;
}

function setup(argv) {
	if (process.platform === "win32") throw new Error("automatic shell integration supports Bash and Zsh on POSIX hosts");
	const options = parseOptions(argv, ["--source", "--target", "--shell"]);
	const shell = selectedShell(options["--shell"]);
	const target = options["--target"] ?? "auto";
	if (!["auto", "gentle-shell", "pi"].includes(target)) throw new Error("--target must be auto, gentle-shell, or pi");
	const resolved = resolveLaunchCommand(target);
	if (!resolved) throw new Error(`could not find ${target === "auto" ? "gentle-shell or pi" : target} on PATH`);
	const source = options["--source"];
	if (run("npm", ["install", "--global", source ?? DEFAULT_SOURCE]) !== 0) return 1;
	// The public path avoids a second Git fetch: Pi loads the exact package npm
	// just installed. A custom local source remains useful for development.
	const piPackage = source ?? globalPiPackagePath();
	if (replaceLegacyPiDeclaration() !== 0) return 1;
	if (run("pi", ["install", piPackage]) !== 0) return 1;
	const integrated = installShellIntegration({ homeDir: homedir(), shell, target: resolved.target });
	console.log(`gentle-retry: ${integrated.changed ? "updated" : "already integrated in"} ${integrated.path}`);
	console.log("Open a new terminal, then use gentle-retry auto-resume on. Bypass the launcher with 'command gentle-shell' or 'command pi'.");
	return 0;
}

function uninstall(argv) {
	const options = parseOptions(argv, ["--shell"]);
	const removed = removeShellIntegration({ homeDir: homedir(), shell: selectedShell(options["--shell"]) });
	console.log(`gentle-retry: ${removed.changed ? "removed shell integration from" : "no shell integration in"} ${removed.path}`);
	console.log("The global command and Pi package were left installed.");
	return 0;
}

function launch(argv) {
	let target = "auto";
	let args = argv;
	if (argv[0] === "--target") {
		target = argv[1];
		args = argv.slice(2);
	} else if (argv[0]?.startsWith("--target=")) {
		target = argv[0].slice("--target=".length);
		args = argv.slice(1);
	}
	if (!["auto", "gentle-shell", "pi"].includes(target)) {
		console.error("gentle-retry: --target must be auto, gentle-shell, or pi");
		return 2;
	}
	if (args[0] === "--") args = args.slice(1);
	const resolved = resolveLaunchCommand(target);
	if (!resolved) {
		console.error(`gentle-retry: could not find ${target === "auto" ? "gentle-shell or pi" : target} on PATH`);
		return 1;
	}
	const plan = buildLaunchPlan({
		targetCommand: resolved.command,
		args,
		autoResumeEnabled: resolveRetryPolicy(process.cwd()).autoResume,
		stdinIsTTY: process.stdin.isTTY === true,
		stdoutIsTTY: process.stdout.isTTY === true,
	});
	return exitForResult(spawnSync(plan.command, plan.args, { stdio: "inherit", env: process.env }));
}

const [command = "setup", ...args] = process.argv.slice(2);
try {
	if (command === "--help" || command === "-h" || command === "help") {
		console.log(help());
	} else if (command === "launch") {
		process.exitCode = launch(args);
	} else if (command === "setup") {
		process.exitCode = setup(args);
	} else if (command === "uninstall") {
		process.exitCode = uninstall(args);
	} else {
		console.error("gentle-retry: expected setup, launch, uninstall, or --help");
		process.exitCode = 2;
	}
} catch (error) {
	console.error(`gentle-retry: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
