import type { SidebarPullRequest } from "./sidebar-chat-status";

/**
 * The sidebar's pull request marks as this browser last read them, by chat.
 * A cookie, so the server renders each row with its PR icon: the live list
 * comes from GitHub after the page loads, and without it every row would
 * first paint its time, then swap to the icon.
 */
export const SIDEBAR_PR_COOKIE = "ytimesy-prs";

/** Marks kept; the open project's are written first. */
const SAVED_PRS_KEPT = 30;

/** A chat's key in the cookie: the start of its id, to keep the cookie small. */
export function savedPrChatKey(chatId: string): string {
	return chatId.replaceAll("-", "").slice(0, 12).toLowerCase();
}

export type SavedSidebarPrs = Readonly<Record<string, SidebarPullRequest>>;

export const NO_SAVED_SIDEBAR_PRS: SavedSidebarPrs = {};

const STATES = {
	o: "open",
	d: "draft",
	m: "merged",
	c: "closed",
} as const satisfies Record<string, SidebarPullRequest["state"]>;
const CHECKS = { p: "passed", f: "failed", n: null } as const satisfies Record<
	string,
	SidebarPullRequest["checks"]
>;
const GITHUB_PULL =
	/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const KEY = /^[0-9a-f]{12}$/;

function letterOf<T>(table: Record<string, T>, value: T): string {
	return Object.entries(table).find(([, known]) => known === value)?.[0] ?? "";
}

/** `key~number~state~checks~failed~owner~repo`; null when the URL is not a GitHub PR's. */
function encodeMark(key: string, pr: SidebarPullRequest): string | null {
	const match = GITHUB_PULL.exec(pr.url);
	if (!match || Number(match[3]) !== pr.number) return null;
	return [
		key,
		pr.number,
		letterOf(STATES, pr.state),
		letterOf(CHECKS, pr.checks),
		pr.failedChecks,
		match[1],
		match[2],
	].join("~");
}

function decodeMark(raw: string): [string, SidebarPullRequest] | null {
	const [key, number, state, checks, failed, owner, repo] = raw.split("~");
	const pullNumber = Number(number);
	const failedChecks = Number(failed);
	if (!key || !KEY.test(key) || !owner || !repo) return null;
	if (!NAME.test(owner) || !NAME.test(repo)) return null;
	if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) return null;
	if (!Number.isSafeInteger(failedChecks) || failedChecks < 0) return null;
	if (!state || !(state in STATES) || !checks || !(checks in CHECKS))
		return null;
	return [
		key,
		{
			number: pullNumber,
			url: `https://github.com/${owner}/${repo}/pull/${pullNumber}`,
			state: STATES[state as keyof typeof STATES],
			checks: CHECKS[checks as keyof typeof CHECKS],
			failedChecks,
		},
	];
}

/** The saved marks from a Cookie header (or document.cookie); unreadable entries are skipped. */
export function savedSidebarPrsFromCookies(
	header: string | null | undefined,
): SavedSidebarPrs {
	const raw = header
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${SIDEBAR_PR_COOKIE}=`))
		?.slice(SIDEBAR_PR_COOKIE.length + 1);
	if (!raw) return {};
	let value: string;
	try {
		value = decodeURIComponent(raw);
	} catch {
		return {};
	}
	const marks: Record<string, SidebarPullRequest> = {};
	for (const entry of value.split("!").slice(0, SAVED_PRS_KEPT)) {
		const decoded = decodeMark(entry);
		if (decoded && !marks[decoded[0]]) marks[decoded[0]] = decoded[1];
	}
	return marks;
}

/** The chat's saved mark, if this browser saw one. */
export function savedSidebarPr(
	saved: SavedSidebarPrs,
	chatId: string,
): SidebarPullRequest | null {
	return saved[savedPrChatKey(chatId)] ?? null;
}

/**
 * The marks to save once the live PR list is read: the listed chats' live
 * marks (a chat without a PR drops its old one), then the other projects'
 * saved marks, up to the cap.
 */
export function nextSavedSidebarPrs(
	saved: SavedSidebarPrs,
	listed: readonly {
		readonly id: string;
		readonly pr?: SidebarPullRequest | null;
	}[],
): SavedSidebarPrs {
	const listedKeys = new Set(listed.map((chat) => savedPrChatKey(chat.id)));
	const entries: [string, SidebarPullRequest][] = [
		...listed.flatMap((chat): [string, SidebarPullRequest][] =>
			chat.pr ? [[savedPrChatKey(chat.id), chat.pr]] : [],
		),
		...Object.entries(saved).filter(([key]) => !listedKeys.has(key)),
	];
	return Object.fromEntries(entries.slice(0, SAVED_PRS_KEPT));
}

/** The cookie value for these marks (no attributes). */
export function savedSidebarPrsValue(saved: SavedSidebarPrs): string {
	return Object.entries(saved)
		.flatMap(([key, pr]) => encodeMark(key, pr) ?? [])
		.join("!");
}

/** The cookie that renders these marks on the next page load. */
export function savedSidebarPrsCookie(saved: SavedSidebarPrs): string {
	const value = savedSidebarPrsValue(saved);
	return value
		? `${SIDEBAR_PR_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`
		: `${SIDEBAR_PR_COOKIE}=; path=/; max-age=0; samesite=lax`;
}
