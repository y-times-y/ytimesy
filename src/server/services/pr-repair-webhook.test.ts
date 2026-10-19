import { Webhooks } from "@octokit/webhooks";
import { afterEach, expect, it, vi } from "vitest";
import { receivePrRepairWebhook } from "./pr-repair-webhook";

const mocks = vi.hoisted(() => ({
	query: vi.fn(async () => ({ rows: [] })),
	enqueue: vi.fn(async () => null),
	stageWakes: vi.fn(async () => 1),
}));
vi.mock("../adapters/pull-request-links", () => ({
	stagePullRequestWakes: mocks.stageWakes,
}));
vi.mock("../adapters/database", () => ({
	database: () => ({ query: mocks.query }),
}));
vi.mock("../jobs/queue", () => ({ enqueuePrRepair: mocks.enqueue }));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

it("rejects unsigned deliveries before accessing the database", async () => {
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "1");
	vi.stubEnv("GITHUB_PR_REPAIR_WEBHOOK_SECRET", "fixture-only");
	const response = await receivePrRepairWebhook(
		new Request("http://localhost/api/github/repair-events", {
			method: "POST",
			body: "{}",
		}),
	);
	expect(response.status).toBe(401);
	expect(mocks.query).not.toHaveBeenCalled();
});
it("rejects oversized signed-shaped deliveries before accessing the database", async () => {
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "1");
	vi.stubEnv("GITHUB_PR_REPAIR_WEBHOOK_SECRET", "fixture-only");
	const response = await receivePrRepairWebhook(
		new Request("http://localhost", {
			method: "POST",
			body: "x".repeat(1_000_001),
			headers: {
				"x-github-delivery": "00000000-0000-4000-8000-000000000001",
				"x-hub-signature-256": `sha256=${"a".repeat(64)}`,
			},
		}),
	);
	expect(response.status).toBe(413);
	expect(mocks.query).not.toHaveBeenCalled();
});
it("accepts a real signed payload and rejects a body changed after signing", async () => {
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "1");
	vi.stubEnv("GITHUB_PR_REPAIR_WEBHOOK_SECRET", "fixture-only");
	const body = JSON.stringify({
		action: "completed",
		repository: { id: 1, full_name: "owner/repo" },
		check_run: { id: 3, head_sha: "a".repeat(40), conclusion: "failure" },
	});
	const signature = await new Webhooks({ secret: "fixture-only" }).sign(body);
	const headers = {
		"x-github-delivery": "00000000-0000-4000-8000-000000000001",
		"x-github-event": "check_run",
		"x-hub-signature-256": signature,
	};
	expect(
		(
			await receivePrRepairWebhook(
				new Request("http://localhost", { method: "POST", headers, body }),
			)
		).status,
	).toBe(200);
	expect(mocks.enqueue).toHaveBeenCalledOnce();
	expect(
		(
			await receivePrRepairWebhook(
				new Request("http://localhost", {
					method: "POST",
					headers,
					body: `${body} `,
				}),
			)
		).status,
	).toBe(401);
});

async function signedDelivery(event: string, payload: unknown) {
	const body = JSON.stringify(payload);
	return new Request("http://localhost", {
		method: "POST",
		body,
		headers: {
			"x-github-delivery": "00000000-0000-4000-8000-000000000002",
			"x-github-event": event,
			"x-hub-signature-256": await new Webhooks({
				secret: "fixture-only",
			}).sign(body),
		},
	});
}

it("stages @ytimesy comments as chat wake-ups only, and failed checks for both", async () => {
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "1");
	vi.stubEnv("GITHUB_PR_REPAIR_WEBHOOK_SECRET", "fixture-only");
	const repository = { id: 1, full_name: "owner/repo" };
	const response = await receivePrRepairWebhook(
		await signedDelivery("issue_comment", {
			action: "created",
			repository,
			installation: { id: 2 },
			sender: { type: "User" },
			issue: { number: 12, pull_request: {} },
			comment: { id: 9, body: "@ytimesy fix the lint", user: { type: "User" } },
		}),
	);
	expect(response.status).toBe(200);
	expect(mocks.stageWakes).toHaveBeenCalledWith({
		repositoryId: 1,
		installationId: 2,
		pullNumbers: [12],
		deliveryId: "00000000-0000-4000-8000-000000000002",
		kind: "comment",
		sourceId: 9,
		headSha: null,
	});
	// Comments never reach task repair's session staging.
	expect(mocks.query).not.toHaveBeenCalled();
	mocks.stageWakes.mockClear();
	await receivePrRepairWebhook(
		await signedDelivery("check_run", {
			action: "completed",
			repository,
			check_run: {
				id: 3,
				head_sha: "a".repeat(40),
				conclusion: "failure",
				pull_requests: [{ number: 12 }],
			},
		}),
	);
	expect(mocks.stageWakes).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: "ci",
			pullNumbers: [12],
			headSha: "a".repeat(40),
		}),
	);
	expect(mocks.query).toHaveBeenCalled();
});
