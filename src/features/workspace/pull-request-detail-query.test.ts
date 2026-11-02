import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetail } from "#/domain/pull-request-review";
import {
	listedPullRequestSummary,
	prefetchPullRequestDetail,
	pullRequestDetailQuery,
	readPullRequestDetail,
} from "./pull-request-detail-query";

const source = { installationId: 1, repositoryId: 9, number: 7 };
const detail = { number: 7, title: "Draft pull request" } as PullRequestDetail;

function answered() {
	let answer!: () => void;
	const fetch = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				answer = () => resolve(Response.json(detail));
			}),
	);
	vi.stubGlobal("fetch", fetch);
	return { fetch, answer: () => answer() };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("pull request details", () => {
	it("sends one request for concurrent reads of the same pull request", async () => {
		const { fetch, answer } = answered();
		const reads = [
			readPullRequestDetail(source),
			readPullRequestDetail(source),
		];
		answer();
		await expect(Promise.all(reads)).resolves.toEqual([detail, detail]);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(
			"/api/github/pull-request?installationId=1&repositoryId=9&number=7",
			expect.objectContaining({ method: "GET" }),
		);
		// A later read asks again.
		const again = readPullRequestDetail(source);
		answer();
		await again;
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("opens on a hover's prefetch without a second request, mounted twice as StrictMode does", async () => {
		const { fetch, answer } = answered();
		const client = new QueryClient({
			defaultOptions: { queries: { staleTime: 15_000, retry: false } },
		});
		prefetchPullRequestDetail(client, source);
		const panel = new QueryObserver(client, {
			...pullRequestDetailQuery(source),
			refetchInterval: 30_000,
		});
		panel.subscribe(() => {})();
		const unsubscribe = panel.subscribe(() => {});
		// Another client (a second mount elsewhere) shares the request in flight.
		void new QueryClient().fetchQuery(pullRequestDetailQuery(source));
		await flush();
		answer();
		await flush();
		expect(panel.getCurrentResult().data).toEqual(detail);
		expect(fetch).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it("shows a fresh prefetch at once and reads an older copy again in the background", async () => {
		const { fetch, answer } = answered();
		let clock = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => clock);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		prefetchPullRequestDetail(client, source);
		await flush();
		answer();
		await flush();
		const fresh = new QueryObserver(client, pullRequestDetailQuery(source));
		const closeFresh = fresh.subscribe(() => {});
		expect(fresh.getCurrentResult().data).toEqual(detail);
		expect(fetch).toHaveBeenCalledTimes(1);
		closeFresh();
		clock += 60_000;
		const later = new QueryObserver(client, pullRequestDetailQuery(source));
		const closeLater = later.subscribe(() => {});
		expect(later.getCurrentResult()).toMatchObject({
			data: detail,
			isFetching: true,
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		answer();
		closeLater();
		vi.restoreAllMocks();
	});

	it("paints the panel from the Overview's listed pull request", () => {
		expect(
			listedPullRequestSummary({
				number: 7,
				url: "https://github.com/acme/app/pull/7",
				head: "ytimesy/fix",
				draft: true,
				state: "open",
				merged: false,
				mergeable: null,
				mergeableState: null,
				title: "Draft pull request",
				base: "main",
				author: "ada",
				additions: 3,
				deletions: 1,
			}),
		).toMatchObject({
			number: 7,
			title: "Draft pull request",
			state: "draft",
			head: "ytimesy/fix",
			base: "main",
			additions: 3,
			deletions: 1,
		});
	});
});
