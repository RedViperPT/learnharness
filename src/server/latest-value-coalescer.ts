/** Shared live-snapshot policy: latest per key wins within a 100ms window.
 * Call flush() before a boundary/terminal event; it also clears the timer. */
export function createLatestValueCoalescer<T>(
	emitBatch: (values: readonly T[]) => void,
	flushMs = 100,
): { queue(key: string, value: T): void; flush(): void } {
	// Map preserves first-insertion order across concurrent keys.
	const pending = new Map<string, T>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (pending.size === 0) return;
		const batch = [...pending.values()];
		pending.clear();
		emitBatch(batch);
	};
	return {
		queue(key, value) {
			pending.set(key, value);
			if (timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				flush();
			}, flushMs);
			// Never hold the process (or test runner) open for a straggler.
			(timer as { unref?: () => void }).unref?.();
		},
		flush,
	};
}
