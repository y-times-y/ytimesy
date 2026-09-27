import { expect, it, vi } from "vitest";
import { prepareProjectCheckout } from "../src/server/services/prepare-project-checkout";

vi.mock("../src/server/adapters/github/installation-token", () => ({
	githubInstallationAccessToken: async () => "installation-fixture",
}));
vi.mock("../src/server/adapters/github/bot-identity", () => ({
	resolveGithubAppBot: async () => ({ name: "Bot", email: "bot@test.invalid" }),
}));

it("shares authenticated checkout logic without putting tokens in host commands", async () => {
	const host = {
		exec: vi.fn(async (command: string) => ({
			exitCode: 0,
			stdout: command.includes("rev-parse HEAD") ? "a".repeat(40) : "",
			stderr: "",
		})),
		writeTextFile: vi.fn(async () => undefined),
	};
	const directory = await prepareProjectCheckout({
		host,
		owner: "org",
		name: "web",
		branch: "main",
		workingBranch: "main",
		installationId: 1,
		home: "/home/ubuntu",
		install: false,
		commit: "a".repeat(40),
	});
	expect(directory).toBe("/home/ubuntu/web");
	expect(host.writeTextFile).toHaveBeenCalledWith(
		"/tmp/ytimesy-gh-token",
		"installation-fixture\n",
	);
	expect(host.writeTextFile).toHaveBeenCalledWith(
		expect.stringContaining("/.git/hooks/commit-msg"),
		expect.any(String),
	);
	expect(JSON.stringify(host.exec.mock.calls)).not.toContain(
		"installation-fixture",
	);
	expect(JSON.stringify(host.exec.mock.calls)).not.toContain("pnpm install");
});

it("rejects a branch that changed between resolution and checkout", async () => {
	const host = {
		exec: async () => ({ exitCode: 0, stdout: "b".repeat(40), stderr: "" }),
		writeTextFile: async () => undefined,
	};
	await expect(
		prepareProjectCheckout({
			host,
			owner: "org",
			name: "web",
			branch: "main",
			workingBranch: "main",
			installationId: 1,
			home: "/home/ubuntu",
			install: false,
			commit: "a".repeat(40),
		}),
	).rejects.toThrow("moved during preparation");
});
