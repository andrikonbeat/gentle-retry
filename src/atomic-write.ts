import { randomBytes } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteFileOptions {
	mode?: number;
}

/**
 * Writes a file atomically by creating its temporary file in the destination
 * directory and renaming it over the destination. Keeping the temporary file
 * beside the destination guarantees that rename stays on one filesystem.
 */
export function atomicWriteFileSync(
	targetPath: string,
	content: string,
	options: AtomicWriteFileOptions = {},
): void {
	const temporaryPath = join(
		dirname(targetPath),
		`.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);

	try {
		writeFileSync(temporaryPath, content, {
			encoding: "utf8",
			flag: "wx",
			mode: options.mode ?? 0o600,
		});
		renameSync(temporaryPath, targetPath);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {}
		throw error;
	}
}
