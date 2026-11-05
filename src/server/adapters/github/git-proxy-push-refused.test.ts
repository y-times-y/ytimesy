import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pushProxiedRepository } from "./git-proxy-transfer";

beforeEach(() => {
	vi.stubEnv("YTIMESY_GIT_PROXY_URL", "https://proxy.example.test/");
	vi.stubEnv("YTIMESY_GIT_PROXY_SECRET", "p".repeat(48));
});
afterEach(() => vi.unstubAllEnvs());

function hostRefusing(stderr: string) {
	let step = 0;
	return {
		exec: async () => {
			step += 1;
			return step === 1
				? { exitCode: 0, stdout: "/tmp/ytimesy-git-proxy-abc\n", stderr: "" }
				: { exitCode: 1, stdout: "", stderr };
		},
		writeTextFile: async () => {},
	};
}

const repository = {
	owner: "o",
	name: "r",
	installationId: 1,
	userId: "00000000-0000-4000-8000-000000000001",
	projectId: "00000000-0000-4000-8000-000000000002",
	directory: "/home/ubuntu/r",
	branch: "ytimesy/chat",
};

it("names the missing Workflows permission when GitHub refuses a push that touches a workflow file", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await expect(
			pushProxiedRepository(
				hostRefusing(
					" ! [remote rejected] publish -> chat (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
				) as never,
				repository as never,
			),
		).rejects.toThrow("GitHub blocked the push");
	} finally {
		warn.mockRestore();
	}
});

it("keeps the generic message for any other refused push", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await expect(
			pushProxiedRepository(
				hostRefusing(" ! [rejected] publish -> chat (fetch first)") as never,
				repository as never,
			),
		).rejects.toThrow(
			"Workspace Git proxy transfer failed; check repository access.",
		);
	} finally {
		warn.mockRestore();
	}
});
