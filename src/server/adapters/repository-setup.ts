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
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
	};
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
