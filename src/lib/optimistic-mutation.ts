import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";

/** One cache entry an action changes before the server answers. */
export type CacheWrite = {
	readonly queryKey: QueryKey;
	readonly update: (current: unknown) => unknown;
};

/** A typed CacheWrite; entries not in the cache yet are left alone. */
export function cacheWrite<T>(
	queryKey: QueryKey,
	update: (current: T) => T,
): CacheWrite {
	return { queryKey, update: (current) => update(current as T) };
}

type Snapshot = readonly { queryKey: QueryKey; data: unknown }[];

const CROSS_TAB_CHANNEL = "ytimesy-cache";

export const SAVE_FAILED_OFFLINE = "Couldn't save. Check your connection.";
export const SAVE_FAILED = "Couldn't save. Try again.";

/** A failed save as the control says it: a request that never reached the server reads plainly. */
export function saveErrorMessage(
	error: Error | null | undefined,
): string | undefined {
	if (!error) return undefined;
	// A server function can reject with a bare Response or an empty Error;
	// the control still says the save failed.
	const message = typeof error.message === "string" ? error.message : "";
	return error instanceof TypeError ||
		/failed to fetch|networkerror|load failed|network request failed/i.test(
			message,
		)
		? SAVE_FAILED_OFFLINE
		: message.trim() || SAVE_FAILED;
}

/**
 * Options to spread into `useMutation`: the screen shows the expected result
 * at once and the server catches up.
 *
 * Saves sharing a `scope` run one at a time in click order, so the server
 * ends on the last click. A failed save puts its snapshot back unless a later
 * save in the scope is still running (that one settles the screen). When the
 * last save in the scope settles, the server's answer (`serverWrites`) or a
 * refetch of the written keys makes the screen match the server, and other
 * tabs refetch those keys too.
 */
export function optimisticMutation<TData, TVariables>(input: {
	readonly queryClient: QueryClient;
	readonly scope: string;
	readonly writes: (variables: TVariables) => readonly CacheWrite[];
	/** The server's answer, written only when no later save in the scope is running. */
	readonly serverWrites?: (
		data: TData,
		variables: TVariables,
	) => readonly { queryKey: QueryKey; data: unknown }[];
	/** Extra keys to refetch once the scope is idle. */
	readonly invalidate?: readonly QueryKey[];
	/** A short toast on failure; omit where the control shows the error inline. */
	readonly errorToast?: string;
}) {
	const { queryClient, scope } = input;
	const mutationKey = ["optimistic", scope];
	const othersRunning = () =>
		queryClient.isMutating({ mutationKey, exact: true }) > 1;
	return {
		mutationKey,
		scope: { id: scope },
		onMutate: async (variables: TVariables): Promise<Snapshot> => {
			const writes = input.writes(variables);
			// A read already on its way would land after the write and undo it.
			await Promise.all(
				writes.map(({ queryKey }) => queryClient.cancelQueries({ queryKey })),
			);
			return writes.flatMap(({ queryKey, update }) => {
				const data = queryClient.getQueryData(queryKey);
				if (data === undefined) return [];
				queryClient.setQueryData(queryKey, update(data));
				return [{ queryKey, data }];
			});
		},
		onError: (
			_error: Error,
			_variables: TVariables,
			snapshot: Snapshot | undefined,
		) => {
			if (!othersRunning())
				for (const { queryKey, data } of snapshot ?? [])
					queryClient.setQueryData(queryKey, data);
			if (input.errorToast) toast.error(input.errorToast);
		},
		onSettled: (
			data: TData | undefined,
			error: Error | null,
			variables: TVariables,
		) => {
			if (othersRunning()) return;
			const answered =
				!error && data !== undefined && input.serverWrites
					? input.serverWrites(data, variables)
					: [];
			for (const write of answered)
				queryClient.setQueryData(write.queryKey, write.data);
			const answeredKeys = new Set(
				answered.map(({ queryKey }) => JSON.stringify(queryKey)),
			);
			const stale = uniqueKeys([
				...input.writes(variables).map(({ queryKey }) => queryKey),
				...(input.invalidate ?? []),
			]).filter((queryKey) => !answeredKeys.has(JSON.stringify(queryKey)));
			announceToOtherTabs([
				...answered.map(({ queryKey }) => queryKey),
				...stale,
			]);
			// Not awaited: the control's error or done state shows without waiting for the refetch.
			for (const queryKey of stale)
				void queryClient.invalidateQueries({ queryKey });
		},
	};
}

function uniqueKeys(keys: readonly QueryKey[]) {
	return [
		...new Map(
			keys.map((queryKey) => [JSON.stringify(queryKey), queryKey]),
		).values(),
	];
}

function announceToOtherTabs(keys: readonly QueryKey[]) {
	if (!keys.length || typeof BroadcastChannel === "undefined") return;
	try {
		const channel = new BroadcastChannel(CROSS_TAB_CHANNEL);
		channel.postMessage(keys);
		channel.close();
	} catch {}
}

/** Refetches what another tab of this browser just saved. Returns the cleanup. */
export function followOtherTabSaves(queryClient: QueryClient): () => void {
	if (typeof BroadcastChannel === "undefined") return () => {};
	const channel = new BroadcastChannel(CROSS_TAB_CHANNEL);
	channel.onmessage = (event: MessageEvent<unknown>) => {
		if (!Array.isArray(event.data)) return;
		for (const queryKey of event.data)
			if (Array.isArray(queryKey))
				void queryClient.invalidateQueries({ queryKey });
	};
	return () => channel.close();
}
