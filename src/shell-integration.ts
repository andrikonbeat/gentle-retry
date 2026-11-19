import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export type IntegrationShell = "bash" | "zsh" | "fish";
export type IntegrationTarget = "gentle-shell" | "pi";

const BEGIN_MARKER = "# >>> gentle-retry auto-resume >>>";
const END_MARKER = "# <<< gentle-retry auto-resume <<<";
const NO_FINAL_NEWLINE = "# original-final-newline: no";

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
	if (input.shell === "fish") return join(input.homeDir, ".config", "fish", "config.fish");
	return join(input.homeDir, input.shell === "bash" ? ".bashrc" : ".zshrc");
}

function renderBlock(target: IntegrationTarget, originalHadFinalNewline: boolean, shell: IntegrationShell): string {
	return [
		BEGIN_MARKER,
		`# original-final-newline: ${originalHadFinalNewline ? "yes" : "no"}`,
		...(shell === "fish"
			? [`function ${target}`, `  command gentle-retry launch --target ${target} -- $argv`, "end"]
			: [`${target}() {`, `  command gentle-retry launch --target ${target} -- "$@"`, "}"]),
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
	let before = content.slice(0, start);
	const block = content.slice(start, end);
	if (block.includes(NO_FINAL_NEWLINE) && before.endsWith("\n")) before = before.slice(0, -1);
	return before + content.slice(content[afterMarker] === "\n" ? afterMarker + 1 : afterMarker);
}

function integratedContent(content: string, target: IntegrationTarget, shell: IntegrationShell): string {
	const existing = withoutExistingBlock(content);
	return `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${renderBlock(target, existing.length === 0 || existing.endsWith("\n"), shell)}`;
}

function updateShellFile(input: ShellIntegrationInput, install: boolean): ShellIntegrationResult {
	const path = shellFile(input);
	const backupPath = `${path}.gentle-retry-backup`;
	const isLink = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
	// Never replace a dotfiles-managed symlink: update its real target instead.
	const writePath = isLink ? realpathSync(path) : path;
	const current = existsSync(writePath) ? readFileSync(writePath, "utf8") : "";
	const next = install ? integratedContent(current, input.target!, input.shell) : withoutExistingBlock(current);
	if (next === current) return { path, backupPath, changed: false };
	if (install && existsSync(writePath) && !existsSync(backupPath)) {
		copyFileSync(writePath, backupPath, constants.COPYFILE_EXCL);
	}
	mkdirSync(dirname(writePath), { recursive: true, mode: 0o700 });
	atomicWriteFileSync(writePath, next, { mode: existsSync(writePath) ? statSync(writePath).mode : 0o600 });
	return { path, backupPath, changed: true };
}

export function installShellIntegration(input: ShellIntegrationInput & { target: IntegrationTarget }): ShellIntegrationResult {
	return updateShellFile(input, true);
}

export function removeShellIntegration(input: ShellIntegrationInput): ShellIntegrationResult {
	return updateShellFile(input, false);
}
