import { expect, it, vi } from "vitest";
import { prepareProjectCheckout } from "../src/server/services/prepare-project-checkout";

vi.mock("../src/server/adapters/github/installation-token", () => ({
	githubInstallationAccessToken: async () => "installation-fixture",
}));
vi.mock("../src/server/adapters/github/git-broker", () => ({
	receiveBrokeredRepository: vi.fn(async () => "updated"),
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
	expect(host.writeTextFile).not.toHaveBeenCalledWith(
		"/tmp/ytimesy-gh-token",
		expect.anything(),
	);
	const setup = host.exec.mock.calls.find(([command]) =>
		command.includes("config --local core.hooksPath"),
	)?.[0];
	expect(setup).toContain("rev-parse --path-format=absolute --git-common-dir");
	expect(setup).toContain('> "$common/ytimesy-hooks/prepare-commit-msg"');
	expect(setup).toContain('> "$common/ytimesy-hooks/pre-push"');
	expect(setup).toContain(
		'chmod +x "$common/ytimesy-hooks/prepare-commit-msg" "$common/ytimesy-hooks/pre-push"',
	);
	expect(setup).toContain(
		'config --local core.hooksPath "$common/ytimesy-hooks"',
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
