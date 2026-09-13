import { expect, it } from "vitest";
import {
	cloneRepositoryArgv,
	githubCloneEnv,
	installArgv,
	repositoryDirectory,
} from "../src/server/adapters/repository-setup";

it("keeps the GitHub token out of clone argv", () => {
	const argv = cloneRepositoryArgv("y-times-y/ytimesy", "master", "/repo");
	expect(argv.join(" ")).not.toMatch(/ghp_|bearer|token/i);
	expect(argv).toContain("https://github.com/y-times-y/ytimesy.git");
	expect(githubCloneEnv("ghp_secret").GIT_CONFIG_VALUE_0).toContain(
		"ghp_secret",
	);
	expect(repositoryDirectory("y-times-y/ytimesy")).toBe("/home/ubuntu/ytimesy");
});

it("selects the lockfile install command", () => {
	expect(installArgv("/repo", ["pnpm-lock.yaml"]).at(-1)).toContain(
		"'pnpm' 'install' '--frozen-lockfile'",
	);
	expect(installArgv("/repo", ["package-lock.json"]).at(-1)).toContain(
		"'npm' 'ci'",
	);
});
