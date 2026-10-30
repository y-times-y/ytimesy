/**
 * A long list with its finished items folded: everything still open shows,
 * plus the last `keep` finished ones; `hidden` is how many finished ones fold.
 * Order is kept.
 */
export function foldFinished<T>(
	items: readonly T[],
	finished: (item: T) => boolean,
	keep: number,
): { readonly shown: readonly T[]; readonly hidden: number } {
	const done = items.filter(finished);
	if (done.length <= keep) return { shown: items, hidden: 0 };
	const kept = new Set(keep > 0 ? done.slice(-keep) : []);
	return {
		shown: items.filter((item) => !finished(item) || kept.has(item)),
		hidden: done.length - kept.size,
	};
}
