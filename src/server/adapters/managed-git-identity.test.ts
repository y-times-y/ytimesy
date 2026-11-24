import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { managedGitSetupCommand } from "./managed-git-identity";

it("configures fresh managed repos, shares identity with worktrees, and rejects overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "ytimesy git identity-"));
	const env = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(root, "no-global-config"),
	};
	for (const key of Object.keys(env)) {
		if (/^GIT_(AUTHOR|COMMITTER|CONFIG_(COUNT|KEY|VALUE|PARAMETERS))/.test(key))
			delete (env as NodeJS.ProcessEnv)[key];
	}
	const run = (command: string, args: string[], overrides = {}) =>
		execFileSync(command, args, {
			cwd: root,
			env: { ...env, ...overrides },
			encoding: "utf8",
			stdio: "pipe",
		});
	const identity =
		"ytimesy-agent[bot] <328807657+ytimesy-agent[bot]@users.noreply.github.com>";
	try {
		run("git", ["init", "-q"]);
		const commit = ["commit", "--allow-empty", "-m", "Agent commit"];
		expect(() => run("git", commit)).toThrow();
		const upstream = join(root, "upstream.git");
		run("git", ["init", "--bare", "-q", upstream]);
		run("git", [
			"-c",
			"user.name=Historical Author",
			"-c",
			"user.email=historic@example.test",
			...commit,
		]);
		run("git", ["push", upstream, "HEAD:refs/heads/main"]);
		run("sh", ["-ec", managedGitSetupCommand(root)]);
		run("git", commit);
		run("git", ["push", upstream, "HEAD:refs/heads/review"]);
		run("git", [
			"-c",
			"core.hooksPath=missing-hooks",
			"-c",
			"committer.email=wrong@example.test",
			...commit,
		]);
		expect(() =>
			run("git", ["push", upstream, "HEAD:refs/heads/rejected"]),
		).toThrow(/unpublished commit does not have the managed Git identity/i);
		const linked = join(root, "linked checkout");
		run("git", ["worktree", "add", "-qb", "helper", linked]);
		run("git", ["-C", linked, ...commit, "--no-verify"]);
		const log = [
			"log",
			"-1",
			"--format=%an <%ae>%n%cn <%ce>%n%(trailers:key=Co-authored-by)",
		];
		expect(run("git", ["-C", linked, ...log]).trim()).toBe(
			`${identity}\n${identity}\nCo-authored-by: ${identity}`,
		);
		expect(() =>
			run("git", [...commit, "--author=Other <other@example.test>"]),
		).toThrow(/managed Git identity/i);
		expect(() =>
			run("git", ["-c", "committer.email=other@example.test", ...commit]),
		).toThrow(/managed Git identity/i);
		expect(() => run("git", commit, { GIT_COMMITTER_NAME: "Other" })).toThrow(
			/managed Git identity/i,
		);
		expect(() =>
			run("git", commit, { GIT_AUTHOR_EMAIL: "other@example.test" }),
		).toThrow(/managed Git identity/i);
		run("sh", ["-ec", managedGitSetupCommand(linked)]);
		run("git", [
			"-C",
			linked,
			...commit,
			"--trailer",
			`Co-authored-by: ${identity}`,
		]);
		expect(run("git", ["-C", linked, ...log]).trim()).toBe(
			`${identity}\n${identity}\nCo-authored-by: ${identity}`,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
