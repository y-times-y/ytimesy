import { githubGitHttpEnv } from "#/domain/github-git-auth";

export function repositoryDirectory(fullName: string) {
	const repo = fullName.split("/")[1];
	if (!repo) throw new Error("Repository name is missing.");
	return `/home/ubuntu/${repo}`;
}

export function cloneRepositoryArgv(
	fullName: string,
	branch: string,
	directory: string,
) {
	const [owner, repo] = fullName.split("/");
	if (!owner || !repo) throw new Error("Repository name is missing.");
	return [
		"git",
		"clone",
		"--branch",
		branch,
		"--single-branch",
		"--depth",
		"1",
		`https://github.com/${owner}/${repo}.git`,
		directory,
	];
}

export function githubCloneEnv(token: string) {
	return githubGitHttpEnv(token);
}

export function githubPushEnv(token: string) {
	return githubCloneEnv(token);
}

export function commitAllArgv(
	directory: string,
	message: string,
	author: { readonly name: string; readonly email: string },
) {
	return [
		"bash",
		"-lc",
		[
			`cd ${shellSingleQuote(directory)}`,
			"git add -A",
			`if git diff --cached --quiet; then echo YTIMESY_NO_COMMIT; else git -c user.name=${shellSingleQuote(author.name)} -c user.email=${shellSingleQuote(author.email)} commit -m ${shellSingleQuote(message)}; fi`,
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

export function pushBranchArgv(directory: string, branch: string) {
	return [
		"bash",
		"-lc",
		`cd ${shellSingleQuote(directory)} && git push -u origin HEAD:${shellSingleQuote(branch)}`,
	];
}

export function commitCreatedOutput(stdout: string) {
	return !stdout.includes("YTIMESY_NO_COMMIT");
}

export function installArgv(directory: string, lockfiles: string[]) {
	const command = lockfiles.includes("pnpm-lock.yaml")
		? ["pnpm", "install", "--frozen-lockfile"]
		: lockfiles.includes("yarn.lock")
			? ["yarn", "install", "--frozen-lockfile"]
			: lockfiles.includes("package-lock.json")
				? ["npm", "ci"]
				: ["npm", "install"];
	return [
		"bash",
		"-lc",
		`cd ${shellSingleQuote(directory)} && ${command.map(shellSingleQuote).join(" ")}`,
	];
}

export function listLockfilesArgv(directory: string) {
	return ["bash", "-lc", `ls -1 ${shellSingleQuote(directory)}`];
}

function shellSingleQuote(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
