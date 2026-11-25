import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error plain .mjs script without declarations
import { commitAttributionProblem } from "../scripts/check-commit-attribution.mjs";

const bot =
	"ytimesy-agent[bot] <328807657+ytimesy-agent[bot]@users.noreply.github.com>";
const person = "163411274+hetpatel-11@users.noreply.github.com";

it("accepts a person as author with the bot as co-author", () => {
	expect(
		commitAttributionProblem({ authorEmail: person, coAuthors: [bot] }),
	).toBeNull();
});

it.each([
	"328807657+ytimesy-agent[bot]@users.noreply.github.com",
	"agent@ytimesy.com",
	"agent@ytimesy.local",
	"noreply@ytimesy.com",
	"a@a",
])("refuses %s as the author", (authorEmail) => {
	expect(commitAttributionProblem({ authorEmail, coAuthors: [bot] })).toMatch(
		/not a person/,
	);
});

it("refuses a commit without the bot trailer", () => {
	expect(
		commitAttributionProblem({ authorEmail: person, coAuthors: [] }),
	).toMatch(/trailer is missing/);
});

it("checks the commits of a real range", () => {
	const root = mkdtempSync(join(tmpdir(), "ytimesy-attribution-"));
	const run = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: join(root, "none"),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Het Patel",
				GIT_AUTHOR_EMAIL: person,
				GIT_COMMITTER_NAME: "ytimesy-agent[bot]",
				GIT_COMMITTER_EMAIL:
					"328807657+ytimesy-agent[bot]@users.noreply.github.com",
			},
		});
	const check = () =>
		execFileSync(
			process.execPath,
			[join(process.cwd(), "scripts/check-commit-attribution.mjs"), "base"],
			{ cwd: root, encoding: "utf8", stdio: "pipe" },
		);
	try {
		run("init", "-q", "-b", "main");
		run("commit", "-q", "--allow-empty", "-m", "base");
		run("tag", "base");
		run(
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"ok",
			"--trailer",
			`Co-authored-by: ${bot}`,
		);
		expect(check()).toMatch(/ok for 1 commit/);
		run("commit", "-q", "--allow-empty", "-m", "no trailer");
		expect(() => check()).toThrow(/trailer is missing/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
