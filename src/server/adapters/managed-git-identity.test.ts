import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	hasManagedPushMetadata,
	managedGitSetupCommand,
} from "./managed-git-identity";

function withDisposableGit(test: (git: GitFixture) => void) {
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
	try {
		test({ root, run });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

type GitFixture = {
	root: string;
	run: (
		command: string,
		args: string[],
		overrides?: Record<string, string>,
	) => string;
};

const identity =
	"ytimesy-agent[bot] <328807657+ytimesy-agent[bot]@users.noreply.github.com>";

it("configures fresh managed repos, shares identity with worktrees, and rejects overrides", () => {
	withDisposableGit(({ root, run }) => {
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
		run("git", ["checkout", "--detach", "HEAD^"]);
		for (const message of [
			"No trailer",
			"Wrong credit\n\nCo-authored-by: Other <other@example.test>",
			`Example\n\nCo-authored-by: ${identity}\n\nThis is body text, not a trailer.`,
		]) {
			run("git", [
				"-c",
				"core.hooksPath=missing-hooks",
				...commit.slice(0, -1),
				message,
			]);
			const rejected = run("git", ["rev-parse", "HEAD"]);
			expect(() =>
				run("git", ["push", upstream, "HEAD:refs/heads/rejected"]),
			).toThrow(/unpublished commit/);
			expect(run("git", ["rev-parse", "HEAD"])).toBe(rejected);
			expect(run("git", ["ls-remote", upstream, "refs/heads/rejected"])).toBe(
				"",
			);
		}
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
	});
});

it("recovers a resumed branch without rewriting it or replacing a remote ref", () => {
	withDisposableGit(({ root, run }) => {
		const git = (...args: string[]) => run("git", args).trim();
		const upstream = join(root, "upstream.git");
		const original = join(root, "original");
		const recovery = join(root, "recovery");
		git("init", "--bare", "-q", upstream);
		git("init", "-q", "-b", "main", original);
		const source = (...args: string[]) => git("-C", original, ...args);
		const recovered = (...args: string[]) => git("-C", recovery, ...args);
		const legacyCommit = (message: string) =>
			source(
				"-c",
				"user.name=Historical Author",
				"-c",
				"user.email=historic@example.test",
				"commit",
				"-qm",
				message,
			);
		const remoteTip = (branch: string) =>
			git(
				"--git-dir",
				upstream,
				"rev-parse",
				"--verify",
				`refs/heads/${branch}`,
			);
		source("remote", "add", "origin", upstream);
		writeFileSync(join(original, "shared.txt"), "base\n");
		source("add", ".");
		legacyCommit("Published base");
		source("push", "origin", "main");
		source("switch", "-c", "legacy-work");
		source("push", "origin", "legacy-work");
		const originalRemoteTip = remoteTip("legacy-work");
		writeFileSync(join(original, "shared.txt"), "original change\n");
		writeFileSync(join(original, "new.txt"), "recover me\n");
		source("add", ".");
		legacyCommit("Unpublished legacy work");
		const blockedTip = source("rev-parse", "HEAD");
		run("sh", ["-ec", managedGitSetupCommand(original)]);
		source("switch", "main");
		writeFileSync(join(original, "shared.txt"), "published change\n");
		source("commit", "-qam", "Published base moved");
		source("push", "origin", "main");
		source("switch", "legacy-work");
		expect(() => source("push", "origin", "legacy-work")).toThrow(
			/unpublished commit/,
		);
		writeFileSync(join(original, "staged.txt"), "staged only\n");
		source("add", "staged.txt");
		writeFileSync(join(original, "staged.txt"), "staged and modified\n");
		writeFileSync(join(original, "untracked.txt"), "untracked only\n");
		const originalStatus = source("status", "--porcelain");
		const originalStaged = source("diff", "--cached");
		const originalUnstaged = source("diff");
		source("fetch", "--no-tags", "--refmap=", "origin", "refs/heads/main");
		const base = source("rev-parse", "FETCH_HEAD");
		source("worktree", "add", "-b", "recover/work", recovery, base);
		expect(() => recovered("merge", "--squash", blockedTip)).toThrow();
		expect(recovered("diff", "--name-only", "--diff-filter=U")).toBe(
			"shared.txt",
		);
		expect(recovered("status", "--porcelain")).not.toMatch(
			/staged\.txt|untracked\.txt/,
		);
		writeFileSync(
			join(recovery, "shared.txt"),
			"published and original changes\n",
		);
		recovered("add", "shared.txt");
		recovered("commit", "-qm", "Recover changes for review");
		expect(recovered("rev-list", `${base}..HEAD`)).toBe(
			recovered("rev-parse", "HEAD"),
		);
		expect(recovered("show", "HEAD:new.txt")).toBe("recover me");
		expect(
			recovered(
				"log",
				"-1",
				"--format=%an <%ae>%n%cn <%ce>%n%(trailers:key=Co-authored-by)",
			),
		).toBe(`${identity}\n${identity}\nCo-authored-by: ${identity}`);
		const pushRecovery = (branch: string) => {
			const ref = `refs/heads/${branch}`;
			return run(
				"git",
				[
					"-C",
					recovery,
					"-c",
					"push.followTags=false",
					"push",
					"origin",
					`HEAD:${ref}`,
				],
				{ YTIMESY_CREATE_RECOVERY_REF: ref },
			);
		};
		expect(() => pushRecovery("main")).toThrow(
			/destination branch already exists/,
		);
		pushRecovery("recover/work");
		pushRecovery("recover/work");
		const published = remoteTip("recover/work");
		expect(published).toBe(recovered("rev-parse", "HEAD"));
		recovered("commit", "--allow-empty", "-qm", "Later changes");
		expect(() => pushRecovery("recover/work")).toThrow(
			/destination branch already exists/,
		);
		expect(remoteTip("recover/work")).toBe(published);
		expect(remoteTip("main")).toBe(base);
		expect(remoteTip("legacy-work")).toBe(originalRemoteTip);
		expect(source("symbolic-ref", "--short", "HEAD")).toBe("legacy-work");
		expect(source("rev-parse", "HEAD")).toBe(blockedTip);
		expect(source("status", "--porcelain")).toBe(originalStatus);
		expect(source("diff", "--cached")).toBe(originalStaged);
		expect(source("diff")).toBe(originalUnstaged);
	});
});
const human = {
	name: "Het Patel",
	email: "163411274+hetpatel-11@users.noreply.github.com",
};
const humanIdentity = `${human.name} <${human.email}>`;

it("a checkout set up for a user makes them the author, the bot a co-author, and refuses anything else", () => {
	withDisposableGit(({ root, run }) => {
		const commit = ["commit", "--allow-empty", "-m", "Agent commit"];
		const upstream = join(root, "upstream.git");
		run("git", ["init", "-q"]);
		run("git", ["init", "--bare", "-q", upstream]);
		run("git", [
			"-c",
			"user.name=Historical Author",
			"-c",
			"user.email=historic@example.test",
			...commit,
		]);
		run("git", ["push", upstream, "HEAD:refs/heads/main"]);
		run("sh", ["-ec", managedGitSetupCommand(root, human)]);

		// Plain git commit: the user is author and committer, the bot a trailer.
		run("git", commit);
		const log = [
			"log",
			"-1",
			"--format=%an <%ae>|%cn <%ce>|%(trailers:key=Co-authored-by,valueonly,unfold)",
		];
		expect(run("git", log).trim()).toBe(
			`${humanIdentity}|${humanIdentity}|${identity}`,
		);
		run("git", ["push", upstream, "HEAD:refs/heads/by-user"]);

		// The bot may be the committer; the user stays the author.
		run("git", commit, {
			GIT_COMMITTER_NAME: "ytimesy-agent[bot]",
			GIT_COMMITTER_EMAIL:
				"328807657+ytimesy-agent[bot]@users.noreply.github.com",
		});
		expect(run("git", log).trim()).toBe(
			`${humanIdentity}|${identity}|${identity}`,
		);
		run("git", ["push", upstream, "HEAD:refs/heads/bot-committer"]);

		// The bot as author (the old behaviour), another person, or no identity are refused.
		for (const env of <Record<string, string>[]>[
			{
				GIT_AUTHOR_NAME: "ytimesy-agent[bot]",
				GIT_AUTHOR_EMAIL:
					"328807657+ytimesy-agent[bot]@users.noreply.github.com",
			},
			{ GIT_AUTHOR_NAME: "Other", GIT_AUTHOR_EMAIL: "other@example.test" },
			{ GIT_COMMITTER_EMAIL: "other@example.test" },
		])
			expect(() => run("git", commit, env)).toThrow(/managed Git identity/i);

		// Commits that skipped the hooks never reach the remote.
		for (const env of <Record<string, string>[]>[
			{
				GIT_AUTHOR_NAME: "ytimesy-agent[bot]",
				GIT_AUTHOR_EMAIL:
					"328807657+ytimesy-agent[bot]@users.noreply.github.com",
				GIT_COMMITTER_NAME: "ytimesy-agent[bot]",
				GIT_COMMITTER_EMAIL:
					"328807657+ytimesy-agent[bot]@users.noreply.github.com",
			},
			{ GIT_AUTHOR_NAME: "Other", GIT_AUTHOR_EMAIL: "other@example.test" },
		]) {
			run(
				"git",
				[
					"-c",
					"core.hooksPath=missing-hooks",
					"commit",
					"--allow-empty",
					"-m",
					"Skipped hooks",
				],
				env,
			);
			expect(() =>
				run("git", ["push", upstream, "HEAD:refs/heads/rejected"]),
			).toThrow(/unpublished commit/i);
			run("git", ["reset", "-q", "--hard", "HEAD^"]);
		}
		run("git", [
			"-c",
			"core.hooksPath=missing-hooks",
			"commit",
			"--allow-empty",
			"-m",
			"No trailer",
		]);
		expect(() =>
			run("git", ["push", upstream, "HEAD:refs/heads/rejected"]),
		).toThrow(/unpublished commit/i);
		expect(run("git", ["ls-remote", upstream, "refs/heads/rejected"])).toBe("");
	});
});

it("judges pushed commit metadata by the user's identity, and by the bot's only when no user is known", () => {
	const botIdentity = identity;
	const trailers = `\n${botIdentity}`;
	const bothHuman = `${humanIdentity}\t${humanIdentity}${trailers}`;
	const botCommitted = `${humanIdentity}\t${botIdentity}${trailers}`;
	const bothBot = `${botIdentity}\t${botIdentity}${trailers}`;
	expect(hasManagedPushMetadata(bothHuman, human)).toBe(true);
	expect(hasManagedPushMetadata(botCommitted, human)).toBe(true);
	expect(hasManagedPushMetadata(bothBot, human)).toBe(false);
	expect(
		hasManagedPushMetadata(`${humanIdentity}\t${humanIdentity}`, human),
	).toBe(false);
	expect(hasManagedPushMetadata(bothBot)).toBe(true);
	expect(hasManagedPushMetadata(bothHuman)).toBe(false);
});
