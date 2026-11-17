import type { SidebarChat, SidebarStatusGroup } from "./sidebar-chats";

/**
 * A Y project's sidebar is two flat, top-level sections of equal weight:
 * "Y²" (one row per Y project, summarising its threads) and "Threads" (the
 * Y projects' threads, one flat list, the project named on each row's second
 * line). Nothing is nested under a project row.
 */

/** Finished threads listed before the rest fold into "Settled N". */
export const THREADS_SETTLED_AFTER = 5;

type Row<P> = { readonly chat: SidebarChat; readonly project: P };

/** What the Y² row's grey line says about the project's threads. */
export function y2Summary(input: {
	readonly working: number;
	readonly needsYou: number;
	readonly total: number;
}): string {
	const parts = [
		input.working ? `${input.working} working` : null,
		input.needsYou ? `${input.needsYou} needs you` : null,
	].filter((part): part is string => part !== null);
	if (parts.length) return parts.join(" · ");
	if (!input.total) return "No threads yet";
	return `All idle · ${input.total} ${input.total === 1 ? "thread" : "threads"}`;
}

export type Y2Row<P> = Row<P> & {
	readonly working: number;
	readonly needsYou: number;
	readonly total: number;
	readonly summary: string;
	/** The newest activity of the Y² chat or any of its threads, if recorded. */
	readonly activityAt: string | null;
};

/**
 * One row per Y project, in the order given (newest first): its thread counts
 * by status, the summary line, and the project's last activity.
 */
export function y2Rows<P extends { readonly id: string }>(input: {
	readonly y2: readonly Row<P>[];
	readonly threads: readonly Row<P>[];
	readonly statusOf: (chat: SidebarChat) => SidebarStatusGroup;
}): Y2Row<P>[] {
	const rows = input.y2.map(({ chat, project }) => {
		const own = input.threads.filter((row) => row.project.id === project.id);
		const statuses = own.map((row) => input.statusOf(row.chat));
		const working = statuses.filter((status) => status === "working").length;
		const needsYou = statuses.filter((status) => status === "needs-you").length;
		const times = [chat, ...own.map((row) => row.chat)]
			.map((item) => item.updatedAt)
			.filter((at): at is string => Boolean(at) && !!Date.parse(at ?? ""));
		const activityAt =
			times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
		return {
			chat,
			project,
			working,
			needsYou,
			total: own.length,
			summary: y2Summary({ working, needsYou, total: own.length }),
			activityAt,
		};
	});
	// Newest activity first, whichever of the Y² chat or its threads moved last.
	const at = (row: Y2Row<P>) =>
		row.activityAt ? Date.parse(row.activityAt) : 0;
	return rows.sort((a, b) => at(b) - at(a));
}

export type ThreadSections<P> = {
	/** Needs you, then Working, then the first finished threads, each keeping the order given. */
	readonly list: readonly Row<P>[];
	/** Finished threads past the fold (the "Settled" group). */
	readonly settled: readonly Row<P>[];
};

/**
 * The Threads section's rows in order: Needs you, Working, then Done by the
 * order given (pins first, then newest). The finished threads past the first
 * THREADS_SETTLED_AFTER fold into `settled`; the open thread never does.
 */
export function threadSections<P>(
	rows: readonly Row<P>[],
	statusOf: (chat: SidebarChat) => SidebarStatusGroup,
	selectedChatId?: string,
): ThreadSections<P> {
	const byStatus = (status: SidebarStatusGroup) =>
		rows.filter((row) => statusOf(row.chat) === status);
	const done = byStatus("done");
	const visible = done.filter(
		(row, index) =>
			index < THREADS_SETTLED_AFTER || row.chat.id === selectedChatId,
	);
	return {
		list: [...byStatus("needs-you"), ...byStatus("working"), ...visible],
		settled: done.filter((row) => !visible.includes(row)),
	};
}

/** "3 threads need you", for the Y² row's needs-you icon. */
export function y2NeedsYouLabel(count: number) {
	return `${count} ${count === 1 ? "thread needs" : "threads need"} you`;
}
