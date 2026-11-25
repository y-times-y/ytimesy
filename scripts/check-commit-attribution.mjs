// Fails when a commit would not credit the user: its author must be a person's
// GitHub account (never the ytimesy bot or a placeholder address) and it must
// carry the bot's Co-authored-by trailer. Plain Node, no install needed, so it
// runs the same on every OS and in CI before dependencies are installed.
// Usage: node scripts/check-commit-attribution.mjs <base> [<head>]
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const BOT_EMAIL =
	"328807657+ytimesy-agent[bot]@users.noreply.github.com";
const BOT_TRAILER = `ytimesy-agent[bot] <${BOT_EMAIL}>`;
const NOT_A_PERSON =
	/(\[bot\]@users\.noreply\.github\.com|^a@a$|@ytimesy\.(com|local)$|^noreply@github\.com$)/i;

/** Returns why a commit would not be credited to a person, or null when it will. */
export function commitAttributionProblem({ authorEmail, coAuthors }) {
	if (NOT_A_PERSON.test(authorEmail))
		return `the author <${authorEmail}> is not a person's GitHub account, so GitHub will not count the commit as their contribution`;
	if (!coAuthors.includes(BOT_TRAILER))
		return `the Co-authored-by: ${BOT_TRAILER} trailer is missing`;
	return null;
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" });
}

function main(base, head = "HEAD") {
	const failures = [];
	const commits = git("rev-list", "--no-merges", `${base}..${head}`)
		.split("\n")
		.filter(Boolean);
	for (const commit of commits) {
		const [authorEmail, subject] = git(
			"show",
			"-s",
			"--format=%ae%x00%s",
			commit,
		)
			.trim()
			.split("\0");
		const coAuthors = git(
			"show",
			"-s",
			"--format=%(trailers:key=Co-authored-by,valueonly,unfold,separator=%x00)",
			commit,
		)
			.split("\0")
			.map((line) => line.trim())
			.filter(Boolean);
		const problem = commitAttributionProblem({ authorEmail, coAuthors });
		if (problem) failures.push(`${commit.slice(0, 10)} ${subject}: ${problem}`);
	}
	if (failures.length) {
		console.error(
			`Commit attribution failed for ${failures.length} commit(s):\n  ${failures.join("\n  ")}\nCommits must be authored by the user's GitHub account with the ytimesy bot as Co-authored-by (see AGENTS.md).`,
		);
		process.exit(1);
	}
	console.log(`Commit attribution ok for ${commits.length} commit(s).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [base, head] = process.argv.slice(2);
	if (!base) {
		console.error(
			"Usage: node scripts/check-commit-attribution.mjs <base> [<head>]",
		);
		process.exit(2);
	}
	main(base, head);
}
