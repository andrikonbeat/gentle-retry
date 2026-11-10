/**
 * Connectivity watcher.
 *
 * The watcher answers one question: can this machine reach the internet right
 * now? It never decides *why* a provider call failed: a timeout with a
 * reachable machine is a provider problem, and a machine that cannot reach
 * anything is an outage. Keeping those two axes apart is what lets the retry
 * sequence and the reconnect sequence live in the same extension without
 * fighting over the same turn.
 *
 * The watcher owns no background timer: probes happen only when a caller asks
 * for one, so a healthy session makes no requests and never keeps the Pi
 * process alive.
 */

export type ConnectivityState = "unknown" | "online" | "offline";

export const CONNECTIVITY_DEFAULT_ENDPOINT = "https://registry.npmjs.org/-/ping";
export const CONNECTIVITY_DEFAULT_TIMEOUT_MS = 2_000;
export const CONNECTIVITY_DEFAULT_INTERVAL_MS = 5_000;

/** One failed probe is not enough to declare an outage: captive portals and flaky DNS are common. */
export const CONNECTIVITY_OFFLINE_THRESHOLD = 2;

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok?: boolean }>;

export interface ConnectivityProbeOptions {
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	endpoint?: string;
}

export interface ConnectivityWatcherOptions extends ConnectivityProbeOptions {
	intervalMs?: number;
	offlineThreshold?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Performs one reachability request. Any failure — a rejected request, a
 * non-ok response, a timeout — means "not reachable right now".
 */
export async function probeConnectivity(options: ConnectivityProbeOptions = {}): Promise<boolean> {
	const endpoint = options.endpoint ?? CONNECTIVITY_DEFAULT_ENDPOINT;
	const timeoutMs = options.timeoutMs ?? CONNECTIVITY_DEFAULT_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
	if (!fetchImpl) return false;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(endpoint, { signal: controller.signal });
		return response.ok === true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Keeps the connectivity state of the machine.
 *
 * The state starts as `unknown`: the watcher reports what it observed, and
 * only claims `offline` after consecutive failed probes. A single successful
 * probe clears the outage, because the machine is reachable again.
 */
export class ConnectivityWatcher {
	readonly #fetchImpl: FetchLike | undefined;
	readonly #endpoint: string;
	readonly #timeoutMs: number;
	readonly #intervalMs: number;
	readonly #offlineThreshold: number;
	#state: ConnectivityState = "unknown";
	#consecutiveFailures = 0;

	constructor(options: ConnectivityWatcherOptions = {}) {
		this.#fetchImpl = options.fetchImpl;
		this.#endpoint = options.endpoint ?? CONNECTIVITY_DEFAULT_ENDPOINT;
		this.#timeoutMs = options.timeoutMs ?? CONNECTIVITY_DEFAULT_TIMEOUT_MS;
		this.#intervalMs = options.intervalMs ?? CONNECTIVITY_DEFAULT_INTERVAL_MS;
		this.#offlineThreshold = options.offlineThreshold ?? CONNECTIVITY_OFFLINE_THRESHOLD;
	}

	get state(): ConnectivityState {
		return this.#state;
	}

	get consecutiveFailures(): number {
		return this.#consecutiveFailures;
	}

	/** Runs one probe and updates the state. */
	async refresh(): Promise<ConnectivityState> {
		const reachable = await probeConnectivity({
			fetchImpl: this.#fetchImpl,
			timeoutMs: this.#timeoutMs,
			endpoint: this.#endpoint,
		});
		if (reachable) {
			this.#consecutiveFailures = 0;
			this.#state = "online";
			return this.#state;
		}
		this.#consecutiveFailures += 1;
		if (this.#consecutiveFailures >= this.#offlineThreshold) this.#state = "offline";
		return this.#state;
	}

	/**
	 * Waits until the machine is reachable again.
	 *
	 * Resolves with the final state: `online` when the connectivity returned,
	 * otherwise the state observed until the timeout. The wait rejects when the
	 * signal aborts, so the caller can cancel it with Esc.
	 */
	async waitForOnline(timeoutMs: number, signal?: AbortSignal): Promise<ConnectivityState> {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		if (this.#state === "online") return this.#state;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const state = await this.refresh();
			if (state === "online") return state;
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await sleep(Math.min(this.#intervalMs, remaining), signal);
		}
		return this.#state;
	}
}
