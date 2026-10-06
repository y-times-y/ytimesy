import { Webhooks } from "@octokit/webhooks";
import { afterEach, expect, it, vi } from "vitest";
import { receivePrRepairWebhook } from "./pr-repair-webhook";

const mocks = vi.hoisted(() => ({
	query: vi.fn(async () => ({ rows: [] })),
	enqueue: vi.fn(async () => null),
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
