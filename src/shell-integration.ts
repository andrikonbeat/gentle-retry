import { constants, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export type IntegrationShell = "bash" | "zsh";
export type IntegrationTarget = "gentle-shell" | "pi";

const BEGIN_MARKER = "# >>> gentle-retry auto-resume >>>";
const END_MARKER = "# <<< gentle-retry auto-resume <<<";

export interface ShellIntegrationInput {
	homeDir: string;
	shell: IntegrationShell;
	target?: IntegrationTarget;
}

export interface ShellIntegrationResult {
	path: string;
	backupPath: string;
	changed: boolean;
}

function shellFile(input: ShellIntegrationInput): string {
	return join(input.homeDir, input.shell === "bash" ? ".bashrc" : ".zshrc");
}

function renderBlock(target: IntegrationTarget): string {
	return [
		BEGIN_MARKER,
		`${target}() {`,
		`  command gentle-retry launch --target ${target} -- "$@"`,
		"}",
		END_MARKER,
		"",
	].join("\n");
}

function withoutExistingBlock(content: string): string {
	const start = content.indexOf(BEGIN_MARKER);
	const end = content.indexOf(END_MARKER);
	if (start === -1 && end === -1) return content;
	if (
		start === -1 || end === -1 || end < start ||
		content.indexOf(BEGIN_MARKER, start + BEGIN_MARKER.length) !== -1 ||
		content.indexOf(END_MARKER, end + END_MARKER.length) !== -1
	) {
		throw new Error("Refusing to change a shell file with ambiguous gentle-retry markers");
	}
	const afterMarker = end + END_MARKER.length;
	return content.slice(0, start) + content.slice(content[afterMarker] === "\n" ? afterMarker + 1 : afterMarker);
}

function integratedContent(content: string, target: IntegrationTarget): string {
	const existing = withoutExistingBlock(content);
	return `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${renderBlock(target)}`;
}

function updateShellFile(input: ShellIntegrationInput, install: boolean): ShellIntegrationResult {
	const path = shellFile(input);
	const backupPath = `${path}.gentle-retry-backup`;
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const next = install ? integratedContent(current, input.target!) : withoutExistingBlock(current);
	if (next === current) return { path, backupPath, changed: false };
	if (install && existsSync(path) && !existsSync(backupPath)) {
		copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
	}
	atomicWriteFileSync(path, next, { mode: existsSync(path) ? statSync(path).mode : 0o600 });
	return { path, backupPath, changed: true };
}

export function installShellIntegration(input: ShellIntegrationInput & { target: IntegrationTarget }): ShellIntegrationResult {
	return updateShellFile(input, true);
}

export function removeShellIntegration(input: ShellIntegrationInput): ShellIntegrationResult {
	return updateShellFile(input, false);
}
