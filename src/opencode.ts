import {
	createOpenCodeRetryState,
	decideOpenCodeRetry,
	resolveOpenCodeRetryPolicy,
	type OpenCodeRetryEvent,
	type OpenCodeRetryState,
} from "./opencode-retry.js";

export interface OpenCodeRegistration {
	dispose(): void | Promise<void>;
}

export interface OpenCodeEvent {
	readonly type: string;
	readonly data?: unknown;
}

export interface OpenCodePluginContext {
	readonly location: { readonly directory: string };
	readonly options?: unknown;
	readonly session: {
		hook(
			name: "retry",
			callback: (event: OpenCodeRetryEvent) => void | Promise<void>,
		): Promise<OpenCodeRegistration>;
	};
	readonly event: {
		subscribe(options?: {
			types?: readonly string[];
			signal?: AbortSignal;
		}): AsyncIterable<OpenCodeEvent>;
	};
}

export interface OpenCodePlugin {
	readonly id: string;
	setup(context: OpenCodePluginContext): Promise<(() => void | Promise<void>) | void>;
}

function sessionIdOf(event: OpenCodeEvent): string | undefined {
	if (typeof event.data !== "object" || event.data === null) return undefined;
	const sessionID = (event.data as { sessionID?: unknown }).sessionID;
	return typeof sessionID === "string" ? sessionID : undefined;
}

export const gentleRetryOpenCodePlugin: OpenCodePlugin = {
	id: "gentle-retry",
	async setup(context: OpenCodePluginContext) {
		const states = new Map<string, OpenCodeRetryState>();
		const registration = await context.session.hook("retry", (event) => {
			const policy = resolveOpenCodeRetryPolicy(context.location.directory, context.options);
			const current = states.get(event.sessionID) ?? createOpenCodeRetryState();
			const outcome = decideOpenCodeRetry({ event, policy, state: current });
			states.set(event.sessionID, outcome.state);
			event.decision = outcome.decision;
		});

		const controller = new AbortController();
		void (async () => {
			try {
				for await (const event of context.event.subscribe({
					types: ["session.execution.succeeded", "session.execution.interrupted"],
					signal: controller.signal,
				})) {
					const sessionID = sessionIdOf(event);
					if (sessionID) states.delete(sessionID);
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					console.error("gentle-retry: OpenCode completion subscription failed", error);
				}
			}
		})();

		return async () => {
			controller.abort();
			await registration.dispose();
		};
	},
};

export default gentleRetryOpenCodePlugin;
