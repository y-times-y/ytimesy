import { expect, it } from "vitest";
import {
	activateGithubBotCommitHookArgv,
	installArgv,
} from "../src/server/adapters/repository-setup";

it("selects the lockfile install command", () => {
	expect(
		installArgv("/repo", ["package.json", "pnpm-lock.yaml"]).at(-1),
	).toContain("corepack pnpm install --frozen-lockfile");
	expect(
		installArgv("/repo", ["package.json", "pnpm-lock.yaml"]).at(-1),
	).toContain("nvm.sh");
	expect(
		installArgv("/repo", ["package.json", "pnpm-lock.yaml"]).at(-1),
	).toContain("$HOME/.nvm");
	expect(
		installArgv("/repo", ["package.json", "package-lock.json"]).at(-1),
	).toContain("npm ci");
	expect(installArgv("/repo", ["README.md"]).at(-1)).not.toContain("npm");
});

it("activates an installation-written Git hook even when it is root-owned", () => {
	expect(activateGithubBotCommitHookArgv("/repo")[2]).toContain(
		"sudo -n chmod +x '/repo/.git/hooks/commit-msg'",
	);
});
