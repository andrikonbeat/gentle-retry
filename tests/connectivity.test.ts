import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// Run the focused tests against TypeScript sources without writing build output
// outside the task's allowed edit surfaces.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith("./") && specifier.endsWith(".js") && context.parentURL?.includes("/src/")) {
			return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
		}
		return nextResolve(specifier, context);
	},
});

const { CONNECTIVITY_DEFAULT_ENDPOINT, ConnectivityWatcher, probeConnectivity } = await import(
	"../src/connectivity.ts"
);

function okFetch(): () => Promise<{ ok: boolean }> {
	return async () => ({ ok: true });
}

function failingFetch(): () => Promise<{ ok: boolean }> {
	return async () => {
		throw new Error("fetch failed");
	};
}

test("the probe reports a reachable endpoint", async () => {
	assert.equal(await probeConnectivity({ fetchImpl: okFetch() }), true);
});

test("the probe reports an unreachable endpoint when the request fails", async () => {
	assert.equal(await probeConnectivity({ fetchImpl: failingFetch() }), false);
});

test("the probe reports an unreachable endpoint when the response is not ok", async () => {
	assert.equal(await probeConnectivity({ fetchImpl: async () => ({ ok: false }) }), false);
});

test("the probe aborts a hanging request after the timeout", async () => {
	let aborted = false;
	const fetchImpl = async (_url: string, init?: { signal?: AbortSignal }): Promise<{ ok: boolean }> =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				aborted = true;
				reject(new Error("aborted"));
			});
		});
	assert.equal(await probeConnectivity({ fetchImpl, timeoutMs: 20 }), false);
	assert.equal(aborted, true);
});

test("the probe uses the npm registry endpoint by default", async () => {
	let requested = "";
	await probeConnectivity({
		fetchImpl: async (url: string) => {
			requested = url;
			return { ok: true };
		},
	});
	assert.equal(requested, CONNECTIVITY_DEFAULT_ENDPOINT);
});

test("the watcher stays unknown after a single failed probe", async () => {
	const watcher = new ConnectivityWatcher({ fetchImpl: failingFetch() });
	assert.equal(await watcher.refresh(), "unknown");
});

test("the watcher declares the machine offline after two consecutive failed probes", async () => {
	const watcher = new ConnectivityWatcher({ fetchImpl: failingFetch() });
	await watcher.refresh();
	assert.equal(await watcher.refresh(), "offline");
});

test("the watcher reports the machine online when a probe succeeds", async () => {
	const watcher = new ConnectivityWatcher({ fetchImpl: okFetch() });
	assert.equal(await watcher.refresh(), "online");
});

test("the watcher clears the offline state when the connectivity returns", async () => {
	let calls = 0;
	const fetchImpl = async (): Promise<{ ok: boolean }> => {
		calls += 1;
		if (calls <= 2) throw new Error("fetch failed");
		return { ok: true };
	};
	const watcher = new ConnectivityWatcher({ fetchImpl });
	await watcher.refresh();
	await watcher.refresh();
	assert.equal(watcher.state, "offline");
	assert.equal(await watcher.refresh(), "online");
});

test("the watcher returns immediately when the machine is already online", async () => {
	let calls = 0;
	const fetchImpl = async (): Promise<{ ok: boolean }> => {
		calls += 1;
		return { ok: true };
	};
	const watcher = new ConnectivityWatcher({ fetchImpl });
	await watcher.refresh();
	assert.equal(await watcher.waitForOnline(1_000), "online");
	assert.equal(calls, 1);
});

test("the watcher waits until the connectivity returns", async () => {
	let calls = 0;
	const fetchImpl = async (): Promise<{ ok: boolean }> => {
		calls += 1;
		if (calls <= 2) throw new Error("fetch failed");
		return { ok: true };
	};
	const watcher = new ConnectivityWatcher({ fetchImpl, intervalMs: 5 });
	assert.equal(await watcher.waitForOnline(2_000), "online");
	assert.equal(calls, 3);
});

test("the watcher gives up when the connectivity does not return in time", async () => {
	const watcher = new ConnectivityWatcher({ fetchImpl: failingFetch(), intervalMs: 5 });
	assert.equal(await watcher.waitForOnline(40), "offline");
});

test("the watcher stops waiting when the wait is aborted", async () => {
	const watcher = new ConnectivityWatcher({ fetchImpl: failingFetch(), intervalMs: 5 });
	const controller = new AbortController();
	const pending = watcher.waitForOnline(5_000, controller.signal);
	controller.abort();
	await assert.rejects(pending, (error: Error) => error.name === "AbortError");
});
