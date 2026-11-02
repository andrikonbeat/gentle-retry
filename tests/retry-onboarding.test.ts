import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ONBOARDING_MARKER_FILE,
	ONBOARDING_MESSAGE,
	onboardingMarkerPath,
	readOnboardingMarker,
	shouldAnnounceOnboarding,
	writeOnboardingMarker,
} from "../dist/retry-onboarding.js";

function scratch() {
	const dir = mkdtempSync(join(tmpdir(), "gentle-retry-onboarding-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
	const s = scratch();
	try {
		assert.equal(readOnboardingMarker(s.dir), "none");
		assert.equal(existsSync(onboardingMarkerPath(s.dir)), false);

		writeOnboardingMarker(s.dir);
		assert.equal(existsSync(onboardingMarkerPath(s.dir)), true);
		assert.equal(readOnboardingMarker(s.dir), "present");
	} finally {
		s.cleanup();
	}
});

test("writing the marker twice is idempotent and leaves valid json", () => {
	const s = scratch();
	try {
		writeOnboardingMarker(s.dir);
		const first = readFileSync(onboardingMarkerPath(s.dir), "utf8");
		writeOnboardingMarker(s.dir);
		assert.equal(readFileSync(onboardingMarkerPath(s.dir), "utf8"), first);
		assert.equal(readOnboardingMarker(s.dir), "present");
		assert.doesNotThrow(() => JSON.parse(first));
	} finally {
		s.cleanup();
	}
});

test("a corrupt marker reads as unreadable rather than as none", () => {
	const s = scratch();
	try {
		writeFileSync(onboardingMarkerPath(s.dir), "{not json", "utf8");
		assert.equal(readOnboardingMarker(s.dir), "unreadable");

		writeFileSync(onboardingMarkerPath(s.dir), JSON.stringify({ schema: "something-else/v9" }), "utf8");
		assert.equal(readOnboardingMarker(s.dir), "unreadable");
	} finally {
		s.cleanup();
	}
});

test("a malformed marker does not stop the marker from being rewritten", () => {
	const s = scratch();
	try {
		writeFileSync(onboardingMarkerPath(s.dir), "{not json", "utf8");
		writeOnboardingMarker(s.dir);
		assert.equal(readOnboardingMarker(s.dir), "present");
	} finally {
		s.cleanup();
	}
});
