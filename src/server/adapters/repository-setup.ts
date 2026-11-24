import { clearStaleGitIndexLock } from "#/domain/git-stale-lock";
import { SECRET_COMMIT_GUARD } from "#/domain/project-secret";
import {
	commitCoAuthorTrailer,
	type PublicationAuthor,
} from "#/domain/publication";

export function repositoryDirectory(fullName: string) {
	const repo = fullName.split("/")[1];
	if (!repo) throw new Error("Repository name is missing.");
	return `/home/ubuntu/${repo}`;
}

/** Directories of generated files, at the root or anywhere below it. */
const GENERATED_DIRECTORIES = [
	"__pycache__",
	"node_modules",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".venv",
	"venv",
	".tox",
	".next",
	".turbo",
	"coverage",
];
const GENERATED_PATTERNS = [
	...GENERATED_DIRECTORIES.flatMap((name) => [`${name}/*`, `*/${name}/*`]),
	// A node_modules symlink (agents link one into git worktrees) is staged as
	// one entry named node_modules; committed, it replaced a real one.
	"node_modules",
	"*/node_modules",
	"*.egg-info/*",
	"*.pyc",
	"*.pyo",
	".DS_Store",
	"*/.DS_Store",
	".coverage",
	"*/.coverage",
];

/**
 * Unstages newly added generated files (caches, virtualenvs, build output)
 * so an automatic commit leaves them on disk but out of history. Files the
 * repository already tracks still commit when changed, moved or deleted.
 * Paths travel NUL-separated and literal, so spaces, newlines and glob
 * characters in names are safe.
 */
export const UNSTAGE_NEW_GENERATED_FILES = `git diff --cached --name-only --diff-filter=A --find-renames -z | { while IFS= read -r -d '' path; do case "$path" in ${GENERATED_PATTERNS.join("|")}) printf '%s\\0' "$path";; esac; done; } | xargs -0 -r git --literal-pathspecs rm -q --cached --ignore-unmatch --`;

export function commitAllArgv(
	directory: string,
	message: string,
	author: PublicationAuthor,
	coAuthor?: PublicationAuthor | null,
	additionalCoAuthor?: PublicationAuthor | null,
) {
	const trailer = [coAuthor, additionalCoAuthor]
		.map((credit) =>
			credit
				? ` --trailer ${shellSingleQuote(commitCoAuthorTrailer(credit))}`
				: "",
		)
		.join("");
	const name = shellSingleQuote(author.name);
	const email = shellSingleQuote(author.email);
	const identity = `GIT_AUTHOR_NAME=${name} GIT_AUTHOR_EMAIL=${email} GIT_COMMITTER_NAME=${name} GIT_COMMITTER_EMAIL=${email}`;
	return [
		"bash",
		"-lc",
		[
			`cd ${shellSingleQuote(directory)}`,
			clearStaleGitIndexLock(directory),
			"git add -A",
			UNSTAGE_NEW_GENERATED_FILES,
			SECRET_COMMIT_GUARD,
			`if git diff --cached --quiet; then echo YTIMESY_NO_COMMIT; else ${identity} git -c user.name=${name} -c user.email=${email} commit -m ${shellSingleQuote(message)}${trailer}; fi`,
		].join(" && "),
	];
}

export function checkoutBranchArgv(directory: string, branch: string) {
	return [
		"bash",
		"-lc",
		`cd ${shellSingleQuote(directory)} && git checkout -B ${shellSingleQuote(branch)}`,
	];
}

export function installArgv(directory: string, lockfiles: string[]) {
	if (!lockfiles.includes("package.json")) {
		return ["bash", "-lc", `cd ${shellSingleQuote(directory)} && true`];
	}
	const command = lockfiles.includes("pnpm-lock.yaml")
		? "corepack pnpm install --frozen-lockfile"
		: lockfiles.includes("yarn.lock")
			? "corepack yarn install --frozen-lockfile"
			: lockfiles.includes("package-lock.json")
				? "npm ci"
				: "npm install";
	return [
		"bash",
		"-lc",
		`cd ${shellSingleQuote(directory)} && ${guestNodePath()} && ${command}`,
	];
}

export function guestNodePath() {
	return `for NVM_CANDIDATE in "\${NVM_DIR:-}" "$HOME/.nvm" /usr/local/nvm; do
  if [ -n "$NVM_CANDIDATE" ] && [ -s "$NVM_CANDIDATE/nvm.sh" ]; then
    export NVM_DIR="$NVM_CANDIDATE"
    . "$NVM_DIR/nvm.sh"
    break
  fi
done
mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
if command -v corepack >/dev/null 2>&1; then
  corepack enable --install-directory "$HOME/.local/bin"
fi`;
}

export function listLockfilesArgv(directory: string) {
	return ["bash", "-lc", `ls -1 ${shellSingleQuote(directory)}`];
}

function shellSingleQuote(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
