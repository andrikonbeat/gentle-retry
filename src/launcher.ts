import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type LaunchTarget = "auto" | "gentle-shell" | "pi";

export interface LaunchDecisionInput {
	args: readonly string[];
	autoResumeEnabled: boolean;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
}

/** Only an otherwise ordinary interactive launch gets an implicit selector. */
export function shouldAutoContinue(input: LaunchDecisionInput): boolean {
	return input.autoResumeEnabled && input.stdinIsTTY && input.stdoutIsTTY && input.args.length === 0;
}

export interface LaunchPlanInput extends LaunchDecisionInput {
	targetCommand: string;
}

export interface LaunchPlan {
	command: string;
	args: string[];
}

export function buildLaunchPlan(input: LaunchPlanInput): LaunchPlan {
	return {
		command: input.targetCommand,
		args: shouldAutoContinue(input) ? ["--continue"] : [...input.args],
	};
}

/** Finds the real executable; shell functions/aliases are intentionally invisible. */
export function findExecutable(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const extensions = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	const candidates = isAbsolute(name)
		? [name]
		: (env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((dir) => extensions.map((extension) => join(dir, `${name}${extension}`)));
	for (const candidate of candidates) {
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep looking for the next executable on PATH.
		}
	}
	return undefined;
}

export function resolveLaunchCommand(
	target: LaunchTarget,
	env: NodeJS.ProcessEnv = process.env,
): { command: string; target: Exclude<LaunchTarget, "auto"> } | undefined {
	if (target !== "auto") {
		const command = findExecutable(target, env);
		return command === undefined ? undefined : { command, target };
	}
	for (const candidate of ["gentle-shell", "pi"] as const) {
		const command = findExecutable(candidate, env);
		if (command !== undefined) return { command, target: candidate };
	}
	return undefined;
}
