import { expect, it } from "vitest";
import {
	checkoutBranchArgv,
	cloneRepositoryArgv,
	commitAllArgv,
	githubCloneEnv,
	githubPushEnv,
	installArgv,
	pushBranchArgv,
	repositoryDirectory,
} from "../src/server/adapters/repository-setup";

it("keeps the GitHub token out of clone argv", () => {
	const argv = cloneRepositoryArgv("y-times-y/ytimesy", "master", "/repo");
	expect(argv.join(" ")).not.toMatch(/ghp_|bearer|token/i);
	expect(argv).toContain("https://github.com/y-times-y/ytimesy.git");
	expect(githubCloneEnv("ghp_secret").GIT_CONFIG_VALUE_0).toMatch(
		/^AUTHORIZATION: basic /,
	);
	expect(githubCloneEnv("ghp_secret").GIT_CONFIG_VALUE_0).not.toContain(
		"ghp_secret",
	);
	expect(githubCloneEnv("ghp_secret").GIT_TERMINAL_PROMPT).toBe("0");
	expect(repositoryDirectory("y-times-y/ytimesy")).toBe("/home/ubuntu/ytimesy");
});

it("selects the lockfile install command", () => {
	expect(installArgv("/repo", ["pnpm-lock.yaml"]).at(-1)).toContain(
		"corepack pnpm install --frozen-lockfile",
	);
	expect(installArgv("/repo", ["pnpm-lock.yaml"]).at(-1)).toContain("nvm.sh");
	expect(installArgv("/repo", ["package-lock.json"]).at(-1)).toContain("npm ci");
});

it("keeps the GitHub token out of commit and push argv", () => {
	const commit = commitAllArgv("/home/ubuntu/app", "Ship feature", {
		name: "Alice",
		email: "alice@example.test",
	});
	expect(commit.join(" ")).toContain("git add -A");
	expect(commit.join(" ")).toContain("Ship feature");
	expect(commit.join(" ")).not.toMatch(/ghp_|bearer|token/i);
	expect(pushBranchArgv("/home/ubuntu/app", "feature").join(" ")).toContain(
		"git push",
	);
	expect(pushBranchArgv("/home/ubuntu/app", "feature").join(" ")).not.toMatch(
		/ghp_|bearer|token/i,
	);
	expect(githubPushEnv("ghp_secret")).toEqual(githubCloneEnv("ghp_secret"));
	expect(
		checkoutBranchArgv("/home/ubuntu/app", "ytimesy-abc").at(-1),
	).toContain("git checkout -B");
});
