import { describe, expect, it } from "vitest";
import { githubGitHttpEnv, githubGitHttpExtraHeader } from "./github-git-auth";

describe("github git HTTP auth", () => {
	it("uses basic x-access-token extraheaders, not bearer", () => {
		const header = githubGitHttpExtraHeader("ghs_secret");
		expect(header.startsWith("AUTHORIZATION: basic ")).toBe(true);
		expect(header).not.toMatch(/bearer/i);
		expect(header).not.toContain("ghs_secret");
		expect(
			Buffer.from(
				header.slice("AUTHORIZATION: basic ".length),
				"base64",
			).toString("utf8"),
		).toBe("x-access-token:ghs_secret");
		expect(githubGitHttpEnv("ghs_secret").GIT_TERMINAL_PROMPT).toBe("0");
	});
});
