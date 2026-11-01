import {
	LOCAL_AGENT_NAMES,
	type LocalImportView,
	localImportSettled,
} from "./local-import-view";

/**
 * "Imported from Claude Code — Open chat" when an import the user started
 * becomes ready while they are elsewhere in the app. The import card marks
 * its import as pending in the browser (it survives the first-run page's
 * full load to the workspace); the workspace polls only pending imports and
 * stops once each settles.
 */

export const PENDING_IMPORTS_KEY = "ytimesy:pending-imports";

/** An import's token lasts 2 hours; a marker older than that can never finish. */
export const PENDING_IMPORT_MAX_AGE_MS = 2 * 60 * 60_000 + 15 * 60_000;

export type PendingImport = { readonly id: string; readonly at: number };

/** The stored markers, unreadable or stale ones dropped. */
export function parsePendingImports(
	raw: string | null,
	now: number,
): PendingImport[] {
	if (!raw) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(item): item is PendingImport =>
				typeof item === "object" &&
				item !== null &&
				typeof item.id === "string" &&
				/^[0-9a-f-]{36}$/i.test(item.id) &&
				typeof item.at === "number" &&
				now - item.at < PENDING_IMPORT_MAX_AGE_MS,
		)
		.slice(-5);
}

/** The markers with this import added (newest last, at most five). */
export function withPendingImport(
	pending: readonly PendingImport[],
	id: string,
	now: number,
): PendingImport[] {
	return [...pending.filter((item) => item.id !== id), { id, at: now }].slice(
		-5,
	);
}

export function withoutPendingImport(
	pending: readonly PendingImport[],
	id: string,
): PendingImport[] {
	return pending.filter((item) => item.id !== id);
}

export type ImportFinishAlert = {
	readonly title: string;
	readonly action: "Open chat";
	readonly href: string;
};

/**
 * What a polled import means for its marker: still pending (keep polling),
 * settled without a chat (drop it quietly), or ready (drop it and alert).
 */
export function importFinishOutcome(
	view: LocalImportView,
):
	| { readonly kind: "pending" }
	| { readonly kind: "settled" }
	| { readonly kind: "ready"; readonly alert: ImportFinishAlert } {
	if (!localImportSettled(view.status)) return { kind: "pending" };
	if (view.status !== "ready" || !view.projectId || !view.sessionId)
		return { kind: "settled" };
	const agent = view.agent ? LOCAL_AGENT_NAMES[view.agent] : null;
	return {
		kind: "ready",
		alert: {
			title: agent ? `Imported from ${agent}` : "Import ready",
			action: "Open chat",
			href: `/?project=${encodeURIComponent(view.projectId)}&chat=${encodeURIComponent(view.sessionId)}`,
		},
	};
}
