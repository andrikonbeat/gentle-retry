import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi invalidates a session's extension context when the session is replaced or
 * reloaded (`/reload`, `/new`, `/resume`). An in-flight run that settles after
 * that still reaches the old handlers, and every read on the dead context
 * throws "This extension ctx is stale after session replacement or reload".
 */
const STALE_CONTEXT_MARKER = "ctx is stale";

/** True when `ctx` belongs to a replaced or reloaded session. */
export function isStaleExtensionContext(ctx: ExtensionContext): boolean {
	try {
		// `mode` is the cheapest guarded read: it throws exactly when the
		// context was invalidated, and it is a plain string otherwise.
		void ctx.mode;
		return false;
	} catch {
		return true;
	}
}

/** True when `error` is Pi's stale-context failure. */
export function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes(STALE_CONTEXT_MARKER);
}

type ExtensionEventHandler = (...args: unknown[]) => unknown;

/** APIs whose `on` already installs the guard. */
const guardedApis = new WeakSet<object>();

/** The context Pi passes to an event handler as its second argument. */
function handlerContext(args: readonly unknown[]): ExtensionContext | undefined {
	const candidate = args[1];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	return candidate as ExtensionContext;
}

function isPromise(value: unknown): value is Promise<unknown> {
	return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/**
 * Wraps an event handler so a replaced session's dead context cannot fail the
 * turn. The handler is skipped when the context is already stale, and a
 * context that dies while an async handler awaits no longer surfaces as an
 * extension error.
 *
 * The wrapper stays synchronous on purpose: Pi reads the return value of some
 * handlers without awaiting it — an `input` handler returns the transformed
 * input — so an async wrapper would replace that value with a pending promise.
 */
export function guardStaleExtensionHandler(handler: ExtensionEventHandler): ExtensionEventHandler {
	return (...args: unknown[]) => {
		const ctx = handlerContext(args);
		if (ctx && isStaleExtensionContext(ctx)) return undefined;
		let result: unknown;
		try {
			result = handler(...args);
		} catch (error) {
			if (isStaleExtensionContextError(error)) return undefined;
			throw error;
		}
		if (!isPromise(result)) return result;
		return result.then(
			(value) => value,
			(error: unknown) => {
				if (isStaleExtensionContextError(error)) return undefined;
				throw error;
			},
		);
	};
}

/**
 * Returns an API whose event handlers tolerate a replaced session, so a late
 * event from the session that was replaced never becomes an extension error.
 *
 * The guard patches `on` on the API object Pi handed to this extension and
 * returns that same object. Identity matters: extensions keep shared state in
 * weak maps keyed by the API, so replacing the object with a proxy would
 * silently split that state in two.
 */
export function guardExtensionEvents(pi: ExtensionAPI): ExtensionAPI {
	if (guardedApis.has(pi)) return pi;
	guardedApis.add(pi);
	const register = pi.on.bind(pi) as unknown as (event: string, handler: ExtensionEventHandler) => () => void;
	pi.on = ((event: string, handler: ExtensionEventHandler) =>
		register(event, guardStaleExtensionHandler(handler))) as unknown as ExtensionAPI["on"];
	return pi;
}
