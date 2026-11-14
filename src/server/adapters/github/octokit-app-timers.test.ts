import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOctokitGitHubListing } from "./octokit-app";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ type: "pkcs1", format: "pem" })
	.toString();

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("GitHub App calls", () => {
	// A timer left running holds a Durable Object (a BackgroundJobRunner)
	// awake, and billed, after its job returned. Octokit's throttling plugin
	// started five never-cleared 60 s intervals on its first request.
	it("leave no timer running after a token is minted", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const requests: string[] = [];
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(
					input instanceof Request ? input.url : String(input),
				);
				requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
				return Response.json(
					{
						token: "ghs_test",
						expires_at: new Date(Date.now() + 3_600_000).toISOString(),
						permissions: { pull_requests: "write" },
						repository_selection: "selected",
					},
					{ status: 201 },
				);
			},
		);

		const token = await createOctokitGitHubListing().installationToken({
			credentials: { appId: "1", privateKey, slug: null },
			installationId: "7",
			repositoryNames: ["repo"],
			pullRequests: "write",
		});

		expect(token).toBe("ghs_test");
		expect(requests).toEqual(["POST /app/installations/7/access_tokens"]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
