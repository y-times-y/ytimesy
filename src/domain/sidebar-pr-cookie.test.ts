import { describe, expect, it } from "vitest";
import type { SidebarPullRequest } from "./sidebar-chat-status";
import {
	nextSavedSidebarPrs,
	SIDEBAR_PR_COOKIE,
	savedSidebarPr,
	savedSidebarPrsCookie,
	savedSidebarPrsFromCookies,
	savedSidebarPrsValue,
} from "./sidebar-pr-cookie";

const CHAT = "47c7a3e8-cfea-43cf-b969-bba29c43b3f3";
const OTHER = "3368c614-1366-48c0-8dd3-a402304e6b00";
const open: SidebarPullRequest = {
	number: 412,
	url: "https://github.com/acme/web.app/pull/412",
	state: "open",
	checks: "failed",
	failedChecks: 2,
};
const merged: SidebarPullRequest = {
	number: 37,
	url: "https://github.com/acme/api_server/pull/37",
	state: "merged",
	checks: null,
	failedChecks: 0,
};

function roundTrip(listed: { id: string; pr: SidebarPullRequest | null }[]) {
	const cookie = savedSidebarPrsCookie(nextSavedSidebarPrs({}, listed));
	return savedSidebarPrsFromCookies(`a=1; ${cookie.split(";")[0]}; b=2`);
}

describe("saved sidebar PR marks", () => {
	it("render the same marks the browser saved", () => {
		const saved = roundTrip([
			{ id: CHAT, pr: open },
			{ id: OTHER, pr: merged },
		]);
		expect(savedSidebarPr(saved, CHAT)).toEqual(open);
		expect(savedSidebarPr(saved, OTHER)).toEqual(merged);
		expect(savedSidebarPr(saved, "ffffffff-0000-0000-0000-000000000000")).toBe(
			null,
		);
	});

	it("drop a listed chat whose PR is gone and keep other projects' marks", () => {
		const saved = roundTrip([
			{ id: CHAT, pr: open },
			{ id: OTHER, pr: merged },
		]);
		const next = nextSavedSidebarPrs(saved, [{ id: CHAT, pr: null }]);
		expect(savedSidebarPr(next, CHAT)).toBe(null);
		expect(savedSidebarPr(next, OTHER)).toEqual(merged);
	});

	it("keep the cookie small", () => {
		const listed = Array.from({ length: 80 }, (_, index) => ({
			id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
			pr: {
				...open,
				number: 1000 + index,
				url: `https://github.com/acme/web.app/pull/${1000 + index}`,
			},
		}));
		const value = savedSidebarPrsValue(nextSavedSidebarPrs({}, listed));
		expect(value.length).toBeLessThan(1600);
		expect(
			Object.keys(savedSidebarPrsFromCookies(`${SIDEBAR_PR_COOKIE}=${value}`)),
		).toHaveLength(30);
	});

	it("never renders a link that is not a GitHub pull request", () => {
		expect(
			savedSidebarPrsValue(
				nextSavedSidebarPrs({}, [
					{ id: CHAT, pr: { ...open, url: "javascript:alert(1)" } },
				]),
			),
		).toBe("");
		expect(
			savedSidebarPrsFromCookies(
				`${SIDEBAR_PR_COOKIE}=47c7a3e8cfea~1~o~n~0~a%22b~c`,
			),
		).toEqual({});
		expect(savedSidebarPrsFromCookies(`${SIDEBAR_PR_COOKIE}=%E0%A4%A`)).toEqual(
			{},
		);
		expect(savedSidebarPrsFromCookies(null)).toEqual({});
	});

	it("clear the cookie when nothing is saved", () => {
		expect(savedSidebarPrsCookie({})).toContain("max-age=0");
	});
});

describe("saved merge answer", () => {
	it("round-trips, and reads marks saved before it was kept", () => {
		const ready = {
			...open,
			checks: "passed" as const,
			failedChecks: 0,
			merge: "ready" as const,
		};
		const value = savedSidebarPrsValue({ "47c7a3e8cfea": ready });
		expect(
			savedSidebarPr(
				savedSidebarPrsFromCookies(`${SIDEBAR_PR_COOKIE}=${value}`),
				CHAT,
			),
		).toEqual(ready);
		const old = value.split("~").slice(0, 7).join("~");
		expect(
			savedSidebarPr(
				savedSidebarPrsFromCookies(`${SIDEBAR_PR_COOKIE}=${old}`),
				CHAT,
			),
		).toEqual({ ...open, checks: "passed", failedChecks: 0 });
	});
});
