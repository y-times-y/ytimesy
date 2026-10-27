import { useMemo, useRef } from "react";

type AnyFunction = (...args: never[]) => unknown;

/**
 * A function that keeps its identity across renders and always calls the
 * latest `callback` (undefined while there is none). Memoized children
 * then skip rendering when only the parent's closure changed.
 */
export function useStableCallback<Callback extends AnyFunction>(
	callback: Callback | undefined,
): Callback | undefined {
	const latest = useRef(callback);
	latest.current = callback;
	const stable = useMemo(
		() =>
			((...args: Parameters<Callback>) =>
				latest.current?.(...args)) as unknown as Callback,
		[],
	);
	return callback ? stable : undefined;
}

/**
 * `actions` (an object of callbacks and flags) as an object that changes
 * only when a flag does or a callback comes or goes; its callbacks call
 * the latest ones.
 */
export function useStableActions<Actions extends object>(
	actions: Actions | undefined,
): Actions | undefined {
	const latest = useRef(actions);
	latest.current = actions;
	const shape = actions
		? Object.entries(actions)
				.map(([key, value]) =>
					typeof value === "function"
						? `${key}()`
						: `${key}=${JSON.stringify(value)}`,
				)
				.join(";")
		: null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt when the shape (flags and which callbacks exist) changes.
	return useMemo(() => {
		const current = latest.current;
		if (!current) return undefined;
		return Object.fromEntries(
			Object.entries(current).map(([key, value]) => [
				key,
				typeof value === "function"
					? (...args: unknown[]) =>
							(
								latest.current?.[key as keyof Actions] as
									| ((...args: unknown[]) => unknown)
									| undefined
							)?.(...args)
					: value,
			]),
		) as Actions;
	}, [shape]);
}
