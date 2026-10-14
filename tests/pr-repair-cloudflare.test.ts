import { Webhooks } from "@octokit/webhooks";
import { expect, it, vi } from "vitest";
import {
	acceptPrRepairWebhook,
	prRepairExecutorUrl,
} from "../src/domain/pr-repair-ingress";

it("accepts the development edge executor and legacy executor IDs, rejecting other origins", () => {
	const host = `ytimesy-model-executor-vm${"a".repeat(32)}.style.dev`;
	expect(prRepairExecutorUrl(`https://${host}`)).toBe(
		`https://${host}/pr-repair-event`,
	);
	expect(
		prRepairExecutorUrl(
			`https://ytimesy-model-executor-${"a".repeat(32)}.style.dev`,
		),
	).toContain("/pr-repair-event");
	const edge =
		"https://ytimesy-edge-executor-development.example-account.workers.dev";
	expect(prRepairExecutorUrl(edge)).toBe(`${edge}/pr-repair-event`);
	expect(prRepairExecutorUrl(`${edge}/`)).toBe(`${edge}/pr-repair-event`);
	for (const origin of [
		"https://ytimesy-edge-executor-development.attacker.workers.dev",
		"https://ytimesy-edge-executor-development.example-account.workers.dev.evil.example",
		"http://ytimesy-edge-executor-development.example-account.workers.dev",
		`http://${host}`,
		`https://user@${host}`,
		`https://${host}:444`,
		`https://${host}/extra`,
		`https://${host}?extra=1`,
		`https://${host}.evil.example`,
		"https://127.0.0.1",
		"https://ytimesy-model-executor-short.style.dev",
	])
		expect(() => prRepairExecutorUrl(origin)).toThrow();
});

const secret = "fixture-only-development-webhook-secret";
const body = JSON.stringify({
	action: "completed",
	repository: { id: 1, full_name: "owner/repo" },
	check_run: {
		id: 3,
		head_sha: "a".repeat(40),
		conclusion: "failure",
		output: { summary: "DO NOT persist this raw payload" },
	},
});
async function request(signed = true) {
	return new Request("https://development.example/github-repair", {
		method: "POST",
		body,
		headers: {
			"x-github-delivery": "00000000-0000-4000-8000-000000000001",
			"x-github-event": "check_run",
			...(signed
				? { "x-hub-signature-256": await new Webhooks({ secret }).sign(body) }
				: {}),
		},
	});
}
it("does not schedule unsigned events", async () => {
	const schedule = vi.fn(async () => {});
	expect(
		(await acceptPrRepairWebhook(await request(false), secret, schedule))
			.status,
	).toBe(401);
	expect(schedule).not.toHaveBeenCalled();
});
it("acknowledges only durable scheduling and stores IDs, not raw review/check payloads", async () => {
	const schedule = vi.fn(async (_delivery: unknown) => {});
	expect(
		(await acceptPrRepairWebhook(await request(), secret, schedule)).status,
	).toBe(202);
	expect(JSON.stringify(schedule.mock.calls)).not.toContain("DO NOT persist");
	expect(JSON.stringify(schedule.mock.calls)).toContain("00000000");
});
it("does not acknowledge an unavailable workflow service", async () => {
	expect(
		(
			await acceptPrRepairWebhook(await request(), secret, async () => {
				throw new Error("unavailable");
			})
		).status,
	).toBe(503);
});
