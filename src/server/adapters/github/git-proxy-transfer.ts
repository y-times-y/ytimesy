import { createHmac } from "node:crypto";
import { switchBrokeredBranchCommand } from "#/domain/git-branch-switch";
import { issueGitProxyGrant } from "#/domain/github-git-proxy";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { GitTransferHost } from "./git-broker";

type Repository = {
	owner: string;
	name: string;
	branch: string;
	installationId: string | number;
	userId?: string;
	projectId?: string;
};

export function gitProxyConfiguration() {
	const endpoint = process.env.YTIMESY_GIT_PROXY_URL;
	if (!endpoint) return null;
	const url = new URL(endpoint);
	const root = process.env.BETTER_AUTH_SECRET;
	const secret =
		process.env.YTIMESY_GIT_PROXY_SECRET ||
		(root && root.length >= 32
			? createHmac("sha256", root)
					.update("ytimesy:git-proxy:development:v1")
					.digest("hex")
			: undefined);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		!secret ||
		secret.length < 32
	)
		throw new Error("Git proxy requires an HTTPS origin and signing secret.");
	return { origin: url.origin, secret };
}

async function checked(
	host: GitTransferHost,
	command: string,
	timeoutMs = 15_000,
) {
	const result = await host.exec(command, timeoutMs);
	if (result.exitCode !== 0)
		throw new Error(
			"Workspace Git proxy transfer failed; check repository access.",
		);
	return result.stdout.trim();
}

/** Private temporary Git config carries only an expiring capability; origin remains credential-free. */
async function withProxyGit<T>(
	host: GitTransferHost,
	input: Repository,
	access: "read" | "write",
	run: (git: string, url: string) => Promise<T>,
) {
	const config = gitProxyConfiguration();
	if (!config || !input.userId || !input.projectId)
		throw new Error("Owner-scoped Git proxy configuration is missing.");
	const headers = await issueGitProxyGrant(config.secret, {
		userId: input.userId,
		projectId: input.projectId,
		owner: input.owner,
		name: input.name,
		installationId: Number(input.installationId),
		access,
	});
	const temporary = await checked(
		host,
		"umask 077; mktemp -d /tmp/ytimesy-git-proxy-XXXXXXXX",
	);
	if (!/^\/tmp\/ytimesy-git-proxy-[a-zA-Z0-9]+$/.test(temporary))
		throw new Error("Invalid private Git configuration directory.");
	const url = `${config.origin}/git/${input.owner}/${input.name}.git`;
	try {
		await host.writeTextFile(
			`${temporary}/config`,
			`[http ${JSON.stringify(`${config.origin}/`)}]\n\tfollowRedirects = false\n${Object.entries(
				headers,
			)
				.map(
					([name, value]) =>
						`\textraHeader = ${JSON.stringify(`${name}: ${value}`)}`,
				)
				.join("\n")}\n`,
		);
		const git = `env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=${quote(`${temporary}/config`)} GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https git -c core.hooksPath=/dev/null -c protocol.ext.allow=never -c fetch.fsckObjects=true -c transfer.fsckObjects=true`;
		return await run(git, url);
	} finally {
		await host
			.exec(
				`rm -f ${quote(`${temporary}/config`)}; rmdir ${quote(temporary)}`,
				10_000,
			)
			.catch(() => undefined);
	}
}

export async function receiveProxiedRepository(
	host: GitTransferHost,
	input: Repository & {
		destination: string;
		workingBranch?: string;
		mode: "clone" | "update" | "switch";
	},
) {
	const dest = quote(input.destination);
	const branch = input.workingBranch || input.branch;
	await checked(
		host,
		`git check-ref-format --branch ${quote(input.branch)}; git check-ref-format --branch ${quote(branch)}`,
	);
	if (input.mode !== "clone") {
		const dirty = await checked(host, `git -C ${dest} status --porcelain`);
		if (dirty && input.mode === "switch")
			throw new Error(
				"Commit or stash this chat's uncommitted changes before switching branches.",
			);
		if (dirty) return "dirty";
	}
	return withProxyGit(host, input, "read", async (git, url) => {
		await checked(
			host,
			`set -eu\n${input.mode === "clone" ? `test ! -e ${dest}\nmkdir -p ${dest}\ngit -C ${dest} init` : `test -z "$(git -C ${dest} status --porcelain)"`}
${git} -C ${dest} fetch --no-tags ${quote(url)} ${quote(`refs/heads/${input.branch}`)}
${input.mode === "clone" ? `git -C ${dest} -c core.hooksPath=/dev/null checkout -b ${quote(branch)} FETCH_HEAD\ngit -C ${dest} remote add origin ${quote(`https://github.com/${input.owner}/${input.name}.git`)}` : input.mode === "switch" ? switchBrokeredBranchCommand(input.destination, branch) : `git -C ${dest} -c core.hooksPath=/dev/null merge --ff-only FETCH_HEAD\ngit -C ${dest} -c core.hooksPath=/dev/null checkout -B ${quote(branch)}`}
${input.mode !== "update" ? `git -C ${dest} update-ref refs/ytimesy/base FETCH_HEAD` : ""}`,
			120_000,
		);
		return "updated";
	});
}

export async function pushProxiedRepository(
	host: GitTransferHost,
	input: Repository & {
		directory: string;
		baseBranch?: string;
		revision?: string;
	},
) {
	if (
		input.revision &&
		!/^refs\/ytimesy\/turn-commits\/[a-f0-9]{64}$/.test(input.revision)
	)
		throw new Error("Invalid completed-turn revision.");
	await checked(host, `git check-ref-format --branch ${quote(input.branch)}`);
	await withProxyGit(host, input, "write", async (git, url) => {
		await checked(
			host,
			`${git} -C ${quote(input.directory)} push ${quote(url)} ${quote(`${input.revision || "HEAD"}:refs/heads/${input.branch}`)}`,
			120_000,
		);
	});
}
