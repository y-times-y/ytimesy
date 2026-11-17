import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { CODEX_CATALOG_REFRESH_BUTTON_MS } from "#/domain/codex-catalog-epoch";
import { isModelUnavailableFailureMessage } from "#/domain/codex-model-unavailable";
import type { ListedModel } from "#/domain/listed-model";
import type { SessionItem } from "#/domain/session-item";
import { useHydrated } from "#/features/app/first-paint";
import { authClient } from "#/features/auth/client";
import {
	codexCatalogQueryOptions,
	recheckCodexCatalogAfterUnavailable,
	refreshCodexCatalog,
	seedCodexCatalog,
} from "./codex-catalog-store";
import { getAgentModelCatalog } from "./model-catalog.fn";

function useLoadCodexCatalog() {
	const loadCatalog = useServerFn(getAgentModelCatalog);
	return useCallback(
		async (force: boolean) =>
			(await loadCatalog({
				data: { provider: "codex", ...(force ? { force: true } : {}) },
			})) as ListedModel[],
		[loadCatalog],
	);
}

/**
 * The user's Codex model list, shared by the picker, its search and the
 * composer. A saved copy (this user, pinned CLI, CODEX_CATALOG_EPOCH) is put
 * in the query cache after hydration, before paint, so the list shows at once
 * and nothing is requested; without one the list is read once.
 */
export function useCodexCatalog() {
	const userId = authClient.useSession().data?.user.id;
	const client = useQueryClient();
	const load = useLoadCodexCatalog();
	const hydrated = useHydrated();
	const [seededFor, setSeededFor] = useState<string | undefined>();
	useLayoutEffect(() => {
		if (!hydrated || !userId) return;
		seedCodexCatalog(client, userId);
		setSeededFor(userId);
	}, [hydrated, userId, client]);
	const query = useQuery({
		...codexCatalogQueryOptions(userId, load),
		enabled: Boolean(userId) && seededFor === userId,
	});
	const [cooling, setCooling] = useState(false);
	const cooldown = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(cooldown.current), []);
	return {
		query,
		models: query.data as ListedModel[] | undefined,
		status: (query.isError && !query.data
			? "error"
			: query.data
				? "ready"
				: "loading") as "loading" | "error" | "ready",
		refetch: () => {
			void query.refetch();
		},
		/** The "Refresh models" button: once per minute, bypassing the server's copy. */
		refresh: () => {
			if (cooling) return;
			setCooling(true);
			cooldown.current = setTimeout(
				() => setCooling(false),
				CODEX_CATALOG_REFRESH_BUTTON_MS,
			);
			void refreshCodexCatalog(client, userId, load, { manual: true });
		},
		refreshing: query.isFetching && Boolean(query.data),
		cooling,
	};
}

/**
 * A live Codex failure that says the model is not offered to this account
 * means the saved list is wrong: it is dropped and read once more, bypassing
 * the server's copy. Failures already in the transcript on first sight are
 * old news and do nothing.
 */
export function useRecheckCodexCatalogOnUnavailable(
	items: readonly SessionItem[],
	harnessId: string,
) {
	const userId = authClient.useSession().data?.user.id;
	const client = useQueryClient();
	const load = useLoadCodexCatalog();
	const seen = useRef<Set<string> | null>(null);
	useEffect(() => {
		const first = seen.current === null;
		const known = seen.current ?? new Set<string>();
		seen.current = known;
		let unavailable = false;
		for (const item of items) {
			if (item.kind !== "error" || known.has(item.id)) continue;
			known.add(item.id);
			if (!first && isModelUnavailableFailureMessage(item.message))
				unavailable = true;
		}
		if (unavailable && harnessId === "codex")
			void recheckCodexCatalogAfterUnavailable(client, userId, load);
	}, [items, harnessId, client, userId, load]);
}
