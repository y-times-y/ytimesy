import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropdownMenu } from "radix-ui";
import { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PullRequestDetail } from "#/domain/pull-request-review";
import {
	type PullRequestReviewStart,
	pullRequestReviewStart,
	startPullRequestReviewThread,
} from "#/domain/pull-request-review";
import {
	PullRequestInspector,
	PullRequestOption,
	PullRequestPickerRow,
} from "./pull-request-inspector";

vi.mock("@tanstack/react-start", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-start")>();
	return { ...actual, useServerFn: (fn: unknown) => fn };
});

const currentSessionId = "33333333-3333-4333-8333-333333333333";
const openedSessionId = "44444444-4444-4444-8444-444444444444";
const projectId = "11111111-1111-4111-8111-111111111111";

const named = {
	number: 12,
	title: "Add parser",
	url: "https://github.com/acme/app/pull/12",
	author: "ada",
	authorName: "Ada Lovelace",
	authorAvatarUrl: "https://avatars.githubusercontent.com/u/1",
	draft: false,
};
const bot = {
	number: 4,
	title: "Fix tests",
	url: "https://github.com/acme/app/pull/4",
	author: "dependabot[bot]",
	authorName: null,
	authorAvatarUrl: null,
	draft: true,
};

describe("pull request picker", () => {
	it("shows each option's author name and avatar", () => {
		const namedRow = renderToStaticMarkup(<PullRequestOption pr={named} />);
		expect(namedRow).toContain("Add parser");
		expect(namedRow).toContain("Ada Lovelace");
		expect(namedRow).toContain("https://avatars.githubusercontent.com/u/1");
		expect(namedRow).toContain("pr-avatar");
		const botRow = renderToStaticMarkup(<PullRequestOption pr={bot} />);
		expect(botRow).toContain("dependabot");
		expect(botRow).not.toContain("<img");
		expect(botRow).toContain("Draft");
	});

	it("gives every row a review button for its own pull request", () => {
		const html = renderToStaticMarkup(
			<DropdownMenu.Root open>
				<DropdownMenu.Content>
					{[named, bot].map((pr) => (
						<PullRequestPickerRow
							key={pr.number}
							pr={pr}
							selected={pr.number === 12}
							reviewing={false}
							reviewDisabled={false}
							onOpen={() => {}}
							onReview={() => {}}
						/>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Root>,
		);
		expect(html).toContain('aria-label="Review #12 with ytimesy"');
		expect(html).toContain('aria-label="Review #4 with ytimesy"');
		expect(html.match(/role="menuitem"/g)).toHaveLength(4);
	});

	it("reviews the row's pull request without opening it", () => {
		const onOpen = vi.fn();
		const onReview = vi.fn();
		const row = PullRequestPickerRow({
			pr: bot,
			selected: false,
			reviewing: false,
			reviewDisabled: false,
			onOpen,
			onReview,
		});
		const [openItem, reviewItem] = Children.toArray(
			row.props.children,
		) as ReactElement<{
			onSelect: (event: { preventDefault: () => void }) => void;
		}>[];
		const preventDefault = vi.fn();
		reviewItem?.props.onSelect({ preventDefault });
		expect(onReview).toHaveBeenCalledTimes(1);
		expect(onOpen).not.toHaveBeenCalled();
		expect(preventDefault).toHaveBeenCalled();
		openItem?.props.onSelect({ preventDefault: () => {} });
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onReview).toHaveBeenCalledTimes(1);
	});

	it("shows the pending row and blocks another review while a chat is created", () => {
		const html = renderToStaticMarkup(
			<DropdownMenu.Root open>
				<DropdownMenu.Content>
					<PullRequestPickerRow
						pr={named}
						selected={false}
						reviewing
						reviewDisabled
						onOpen={() => {}}
						onReview={() => {}}
					/>
					<PullRequestPickerRow
						pr={bot}
						selected={false}
						reviewing={false}
						reviewDisabled
						onOpen={() => {}}
						onReview={() => {}}
					/>
				</DropdownMenu.Content>
			</DropdownMenu.Root>,
		);
		expect(html).toContain("Starting…");
		expect(html.match(/data-pending="true"/g)).toHaveLength(1);
		expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
	});

	it("hides row review without a project", () => {
		const html = renderToStaticMarkup(
			<DropdownMenu.Root open>
				<DropdownMenu.Content>
					<PullRequestPickerRow
						pr={named}
						selected
						reviewing={false}
						reviewDisabled={false}
						onOpen={() => {}}
					/>
				</DropdownMenu.Content>
			</DropdownMenu.Root>,
		);
		expect(html).not.toContain("Review");
	});

	it("offers Review with ytimesy on the open pull request", () => {
		const detail: PullRequestDetail = {
			number: 12,
			title: "Add parser",
			body: "",
			url: named.url,
			state: "open",
			head: "feature",
			headSha: "a".repeat(40),
			base: "main",
			author: "ada",
			authorAvatarUrl: named.authorAvatarUrl,
			createdAt: "2026-10-01T00:00:00.000Z",
			updatedAt: "2026-10-02T00:00:00.000Z",
			mergeable: true,
			mergeableState: "clean",
			additions: 1,
			deletions: 0,
			changedFiles: 1,
			comments: 0,
			checks: [],
			reviews: [],
			files: [],
			conversation: [],
			participants: [],
		};
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			},
		});
		client.setQueryData(["pull-request", 9, 12], detail);
		client.setQueryData(["pull-requests", "open", 9], {
			pullRequests: [named, bot],
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<PullRequestInspector
					repository={{ installationId: 1, repositoryId: 9, number: 12 }}
					projectId={projectId}
					harnessId="codex"
					modelId="gpt-5"
					currentSessionId={currentSessionId}
				/>
			</QueryClientProvider>,
		);
		expect(html).toContain("Review with ytimesy");
		expect(html).toContain('class="pr-button"');
	});
});

describe("review action", () => {
	it("starts a new session instead of posting into the current one", async () => {
		const request = pullRequestReviewStart({
			projectId,
			harnessId: "codex",
			modelId: "gpt-5",
			requestId: "22222222-2222-4222-8222-222222222222",
			pull: {
				fullName: "acme/app",
				number: 12,
				title: "Add parser",
				url: named.url,
			},
		});
		expect(request).not.toHaveProperty("sessionId");
		expect(JSON.stringify(request)).not.toContain(currentSessionId);
		const start = vi.fn(async (sent: PullRequestReviewStart) => {
			expect(sent).not.toHaveProperty("sessionId");
			return { sessionId: openedSessionId };
		});
		await expect(
			startPullRequestReviewThread({
				currentSessionId,
				request,
				start,
			}),
		).resolves.toBe(openedSessionId);
		expect(start).toHaveBeenCalledWith(request);
		await expect(
			startPullRequestReviewThread({
				currentSessionId,
				request,
				start: async () => ({ sessionId: currentSessionId }),
			}),
		).rejects.toThrow("A pull request review starts a new chat.");
	});
});
