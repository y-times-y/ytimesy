import {
	commitCoAuthorTrailer,
	type PublicationAuthor,
} from "#/domain/publication";

export function repositoryDirectory(fullName: string) {
	const repo = fullName.split("/")[1];
	if (!repo) throw new Error("Repository name is missing.");
	return `/home/ubuntu/${repo}`;
}

export function githubBotCommitHookPath(directory: string) {
	return `${directory.replace(/\/$/, "")}/.git/hooks/commit-msg`;
}

export function activateGithubBotCommitHookArgv(directory: string) {
	const hook = shellSingleQuote(githubBotCommitHookPath(directory));
	return ["bash", "-lc", `chmod +x ${hook} || sudo -n chmod +x ${hook}`];
}

export function githubBotCommitMsgHook(bot: PublicationAuthor) {
	return `#!/bin/sh
trailer=${JSON.stringify(commitCoAuthorTrailer(bot))}
if grep -F -q "$trailer" "$1"; then
  exit 0
fi
printf '\\n%s\\n' "$trailer" >> "$1"
`;
}

export function configureCommitAuthorArgv(
	directory: string,
	author: { readonly name: string; readonly email: string },
) {
	return [
		"bash",
		"-lc",
		[
			`git -C ${shellSingleQuote(directory)} config user.name ${shellSingleQuote(author.name)}`,
			`git -C ${shellSingleQuote(directory)} config user.email ${shellSingleQuote(author.email)}`,
		].join(" && "),
	];
}

export function commitAllArgv(
	directory: string,
	message: string,
	author: PublicationAuthor,
	coAuthor?: PublicationAuthor | null,
) {
	const trailer = coAuthor
		? ` -m ${shellSingleQuote(commitCoAuthorTrailer(coAuthor))}`
		: "";
	return [
		"bash",
		"-lc",
		[
			`cd ${shellSingleQuote(directory)}`,
			"git add -A",
			`if git diff --cached --quiet; then echo YTIMESY_NO_COMMIT; else git -c user.name=${shellSingleQuote(author.name)} -c user.email=${shellSingleQuote(author.email)} commit -m ${shellSingleQuote(message)}${trailer}; fi`,
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
