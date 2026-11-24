import { expect, it } from "vitest";
import { installArgv } from "../src/server/adapters/repository-setup";

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
