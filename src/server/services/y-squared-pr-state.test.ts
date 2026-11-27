import { beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
	pull: vi.fn(),
	closeIfLanded: vi.fn(),
}));
vi.mock("../adapters/database", () => ({
	database: () => ({
		query: async () => ({ rows: [{ installation_id: "7" }] }),
	}),
}));
vi.mock("../adapters/github/pull-request-wake-github", () => ({
	pullRequestWakeGitHub: async () => github,
}));

import { pullRequestIsOpen } from "./y-squared-pr-state";

const input = {
	userId: "u",
	projectId: "p",
	url: "https://github.com/acme/app/pull/128",
};

describe("pullRequestIsOpen", () => {
	beforeEach(() => vi.resetAllMocks());

	it("closes an open pull request whose commits already landed, and reports it not open", async () => {
		github.pull.mockResolvedValue({
			open: true,
			baseRef: "main",
			headSha: "a",
		});
		github.closeIfLanded.mockResolvedValue(true);
		expect(await pullRequestIsOpen(input)).toBe(false);
		expect(github.closeIfLanded).toHaveBeenCalledOnce();
	});

	it("keeps a pull request with unmerged commits open", async () => {
		github.pull.mockResolvedValue({
			open: true,
			baseRef: "main",
			headSha: "a",
		});
		github.closeIfLanded.mockResolvedValue(false);
		expect(await pullRequestIsOpen(input)).toBe(true);
	});

	it("stays open when closing fails (the App lacks Pull requests: write)", async () => {
		github.pull.mockResolvedValue({
			open: true,
			baseRef: "main",
			headSha: "a",
		});
		github.closeIfLanded.mockRejectedValue(new Error("403"));
		expect(await pullRequestIsOpen(input)).toBe(true);
	});

	it("does not touch one already merged or closed", async () => {
		github.pull.mockResolvedValue({ open: false });
		expect(await pullRequestIsOpen(input)).toBe(false);
		expect(github.closeIfLanded).not.toHaveBeenCalled();
	});
});
