import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	importFinishOutcome,
	PENDING_IMPORTS_KEY,
	type PendingImport,
	parsePendingImports,
	withoutPendingImport,
	withPendingImport,
} from "#/domain/import-finish-alert";
import { tabTitle } from "#/domain/turn-finish-alerts";
import { showNotification } from "../app/safe-notification";
import { localImportStatusFn } from "./local-import.fn";

const POLL_MS = 5000;
const CHANGED_EVENT = "ytimesy:pending-imports";

function readPending(): PendingImport[] {
	try {
		return parsePendingImports(
			window.localStorage.getItem(PENDING_IMPORTS_KEY),
			Date.now(),
		);
	} catch {
		return [];
	}
}

function writePending(next: readonly PendingImport[]) {
	try {
		if (next.length)
			window.localStorage.setItem(PENDING_IMPORTS_KEY, JSON.stringify(next));
		else window.localStorage.removeItem(PENDING_IMPORTS_KEY);
	} catch {
		// Storage blocked: the card still shows its own status.
	}
	window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** The card: this import may finish after the user leaves it. */
export function markImportPending(id: string) {
	writePending(withPendingImport(readPending(), id, Date.now()));
}

export function clearPendingImport(id: string) {
	writePending(withoutPendingImport(readPending(), id));
}

/** Imports whose card is on screen: the card shows their result itself. */
const watchedByCard = new Set<string>();

export function useCardWatchesImport(id: string | null) {
	useEffect(() => {
		if (!id) return;
		watchedByCard.add(id);
		return () => {
			watchedByCard.delete(id);
		};
	}, [id]);
}

function pageAway() {
	return document.hidden || !document.hasFocus();
}

/**
 * In the workspace: an import the user started (onboarding, Settings >
 * Import) that becomes ready shows "Imported from <Agent>" with Open chat,
 * a tab dot and a desktop notification when the page is in the background.
 * Polls only imports marked pending, and nothing when there are none.
 */
export function useImportFinishAlert() {
	const readStatus = useServerFn(localImportStatusFn);
	const queryClient = useQueryClient();
	// Read after mount: the server render has no storage, and nothing here paints.
	const [pending, setPending] = useState<PendingImport[]>([]);
	useEffect(() => {
		const sync = () => setPending(readPending());
		sync();
		window.addEventListener(CHANGED_EVENT, sync);
		window.addEventListener("storage", sync);
		return () => {
			window.removeEventListener(CHANGED_EVENT, sync);
			window.removeEventListener("storage", sync);
		};
	}, []);
	const results = useQueries({
		queries: pending.map((item) => ({
			// The card's own key: while it is open, both share one poll.
			queryKey: ["local-import", item.id],
			queryFn: () => readStatus({ data: { importId: item.id } }),
			refetchInterval: POLL_MS,
			refetchIntervalInBackground: true,
			retry: 1,
		})),
	});
	const handled = useRef(new Set<string>());
	useEffect(() => {
		results.forEach((result, index) => {
			const item = pending[index];
			if (!item || handled.current.has(item.id)) return;
			if (result.isError) {
				// Not this user's, or gone: stop asking.
				handled.current.add(item.id);
				clearPendingImport(item.id);
				return;
			}
			if (!result.data) return;
			const outcome = importFinishOutcome(result.data);
			if (outcome.kind === "pending") return;
			handled.current.add(item.id);
			clearPendingImport(item.id);
			if (outcome.kind !== "ready" || watchedByCard.has(item.id)) return;
			void queryClient.invalidateQueries({ queryKey: ["projects"] });
			const { alert } = outcome;
			const open = () => window.location.assign(alert.href);
			toast(alert.title, {
				id: `import-${item.id}`,
				duration: 15_000,
				action: { label: alert.action, onClick: open },
			});
			if (!pageAway()) return;
			document.title = tabTitle(document.title, true);
			showNotification(
				alert.title,
				{
					body: alert.action,
					tag: `ytimesy-import-${item.id}`,
					icon: "/brand/github-avatar.png",
				},
				open,
			);
		});
	});
}
