import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

// Run the focused tests against TypeScript sources without writing build output
// outside the task's allowed edit surfaces. The published build still uses the
// conventional .js specifiers.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const {
	ONBOARDING_MARKER_FILE,
	ONBOARDING_MESSAGE,
	onboardingMarkerPath,
	readOnboardingMarker,
	shouldAnnounceOnboarding,
	writeOnboardingMarker,
} = await import("../src/retry-onboarding.ts");

const scratchDirectories: string[] = [];
const originalTmpDir = process.env.TMPDIR;

afterEach(() => {
	if (originalTmpDir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpDir;
	for (const directory of scratchDirectories.splice(0).reverse()) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {}
	}
});

function scratch(prefix: string, root = tmpdir()): string {
	const directory = mkdtempSync(join(root, prefix));
	scratchDirectories.push(directory);
	return directory;
}

test("announces only when the policy is off, there is a UI, and nothing was announced before", () => {
	assert.equal(shouldAnnounceOnboarding({ policy: "off", hasUI: true, marker: "none" }), true);
	assert.equal(shouldAnnounceOnboarding({ policy: "on", hasUI: true, marker: "none" }), false);
	assert.equal(shouldAnnounceOnboarding({ policy: "off", hasUI: false, marker: "none" }), false);
	assert.equal(shouldAnnounceOnboarding({ policy: "off", hasUI: true, marker: "present" }), false);
});

test("an unreadable marker fails closed to silence instead of repeating the notice", () => {
	assert.equal(shouldAnnounceOnboarding({ policy: "off", hasUI: true, marker: "unreadable" }), false);
});

test("the notice names the exact command that turns retry on", () => {
	assert.match(ONBOARDING_MESSAGE, /\/gentle:retry enable/);
	assert.match(ONBOARDING_MESSAGE, /OFF/);
	assert.match(ONBOARDING_MESSAGE, /429/);
});

test("the marker lives in the resolved config home", () => {
	assert.equal(onboardingMarkerPath("/tmp/config-home"), join("/tmp/config-home", ONBOARDING_MARKER_FILE));
});

test("a missing marker reads as none and writing it reads back as present", () => {
	const configHome = scratch("gentle-retry-onboarding-");
	assert.equal(readOnboardingMarker(configHome), "none");
	assert.equal(existsSync(onboardingMarkerPath(configHome)), false);

	writeOnboardingMarker(configHome);
	assert.equal(existsSync(onboardingMarkerPath(configHome)), true);
	assert.equal(readOnboardingMarker(configHome), "present");
});

test("writing the marker twice is idempotent and leaves valid json", () => {
	const configHome = scratch("gentle-retry-onboarding-");
	writeOnboardingMarker(configHome);
	const first = readFileSync(onboardingMarkerPath(configHome), "utf8");
	writeOnboardingMarker(configHome);
	assert.equal(readFileSync(onboardingMarkerPath(configHome), "utf8"), first);
	assert.equal(readOnboardingMarker(configHome), "present");
	assert.doesNotThrow(() => JSON.parse(first));
});

test("a corrupt marker reads as unreadable rather than as none", () => {
	const configHome = scratch("gentle-retry-onboarding-");
	writeFileSync(onboardingMarkerPath(configHome), "{not json", "utf8");
	assert.equal(readOnboardingMarker(configHome), "unreadable");

	writeFileSync(onboardingMarkerPath(configHome), JSON.stringify({ schema: "something-else/v9" }), "utf8");
	assert.equal(readOnboardingMarker(configHome), "unreadable");
});

test("a malformed marker does not stop the marker from being rewritten", () => {
	const configHome = scratch("gentle-retry-onboarding-");
	writeFileSync(onboardingMarkerPath(configHome), "{not json", "utf8");
	writeOnboardingMarker(configHome);
	assert.equal(readOnboardingMarker(configHome), "present");
});

test("the onboarding marker write works across filesystems from the OS temporary directory", () => {
	const configHome = scratch("gentle-retry-onboarding-home-", homedir());
	const operatingSystemTemp = scratch("gentle-retry-onboarding-os-temp-", tmpdir());
	assert.notEqual(
		statSync(configHome).dev,
		statSync(operatingSystemTemp).dev,
		"the regression requires config and OS temporary paths on different filesystems",
	);
	process.env.TMPDIR = operatingSystemTemp;

	writeOnboardingMarker(configHome);

	assert.equal(readOnboardingMarker(configHome), "present");
});
