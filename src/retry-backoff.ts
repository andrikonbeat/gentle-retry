export function retryDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	random: () => number = Math.random,
): number {
	const exponential = baseDelayMs * Math.pow(1.8, attempt - 1);
	const jitter = exponential * 0.1 * random();
	return Math.round(Math.min(exponential + jitter, maxDelayMs));
}
