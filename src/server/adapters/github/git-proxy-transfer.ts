import { createHmac } from "node:crypto";
import { fetchedBranchCommand } from "#/domain/git-branch-switch";
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

/**
 * Only a failed fetch or push says this; chat failure wording reads it as
 * "could not fetch its repository", so local Git steps must not use it.
 */
const TRANSFER_FAILED =
	"Workspace Git proxy transfer failed; check repository access.";

/** Fetches, pushes and the checkout of what was fetched. */
const NETWORK_GIT_TIMEOUT_MS = 120_000;

async function checked(
	host: GitTransferHost,
	command: string,
	failure: string,
	timeoutMs = 15_000,
) {
	const result = await host.exec(command, timeoutMs);
	if (result.exitCode !== 0) {
		// Operators need the cause; capability URLs never reach the log.
		console.warn("Workspace Git command failed", {
			failure,
			exitCode: result.exitCode,
			stderr: String((result as { stderr?: unknown }).stderr ?? "")
				.replace(/https?:\/\/\S+/g, "<url>")
				.trim()
				.split("\n")
				.slice(-3)
				.join(" | ")
				.slice(0, 400),
		});
		throw new Error(failure);
	}
	return result.stdout.trim();
}

/**
 * Private temporary Git config carries only an expiring capability; origin
 * remains credential-free. A write capability updates only `input.branch`,
 * once, and the proxy refuses deletes and every other ref.
 */
async function withProxyGit<T>(
	host: GitTransferHost,
	input: Repository,
	access: "read" | "write",
	run: (git: string, url: string, temporary: string) => Promise<T>,
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
		...(access === "write" ? { branch: input.branch } : {}),
	});
	const temporary = await checked(
		host,
		"umask 077; mktemp -d /tmp/ytimesy-git-proxy-XXXXXXXX",
		"Workspace Git could not prepare its private configuration.",
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
		return await run(git, url, temporary);
	} finally {
		await host
			.exec(`rm -rf ${quote(temporary)}`, 10_000)
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
		`git check-ref-format --branch ${quote(input.branch)} && git check-ref-format --branch ${quote(branch)}`,
		"Workspace Git rejected the branch name.",
	);
	if (input.mode !== "clone") {
		const dirty = await checked(
			host,
			`git -C ${dest} status --porcelain`,
			"Workspace Git could not read the checkout's status.",
		);
		if (dirty && input.mode === "switch")
			throw new Error(
				"Commit or stash this chat's uncommitted changes before switching branches.",
			);
		if (dirty) return "dirty";
	}
	return withProxyGit(host, input, "read", async (git, url) => {
		await checked(
			host,
			`set -eu\n${input.mode === "clone" ? `test ! -e ${dest}\nmkdir -p ${dest}\ngit -C ${dest} init` : `test -z "$(git -C ${dest} status --porcelain)"`}`,
			input.mode === "clone"
				? "Workspace Git could not create the checkout."
				: "Workspace Git found uncommitted changes in the checkout.",
		);
		await checked(
			host,
			`${git} -C ${dest} fetch --no-tags ${quote(url)} ${quote(`refs/heads/${input.branch}`)}`,
			TRANSFER_FAILED,
			NETWORK_GIT_TIMEOUT_MS,
		);
		await checked(
			host,
			`set -eu\n${fetchedBranchCommand({
				directory: input.destination,
				branch: input.branch,
				workingBranch: branch,
				mode: input.mode,
				originUrl: `https://github.com/${input.owner}/${input.name}.git`,
			})}`,
			input.mode === "update"
				? "Workspace Git could not fast-forward the checkout to its branch."
				: "Workspace Git could not check out the fetched branch.",
			// Writing a large repository's working tree on a slow VM can take as
			// long as fetching it, which once shared this step's budget.
			NETWORK_GIT_TIMEOUT_MS,
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
	await checked(
		host,
		`git check-ref-format --branch ${quote(input.branch)}`,
		"Workspace Git rejected the branch name.",
	);
	await withProxyGit(host, input, "write", async (git, url, temporary) => {
		// The checkout's own config is the agent's to write (http.proxy,
		// url.*.insteadOf, http.curloptResolve...), so the push runs from a
		// fresh repository that borrows the checkout's objects but none of
		// its config.
		const directory = quote(input.directory);
		const publish = quote(`${temporary}/push.git`);
		await checked(
			host,
			`set -eu
objects=$(cd ${directory} && cd "$(git rev-parse --git-path objects)" && pwd -P)
commit=$(git -C ${directory} rev-parse --verify ${quote(`${input.revision || "HEAD"}^{commit}`)})
${git} init -q --bare ${publish}
printf '%s\n' "$objects" > ${quote(`${temporary}/push.git/objects/info/alternates`)}
${git} --git-dir=${publish} update-ref refs/heads/publish "$commit"`,
			"Workspace Git could not prepare the commit to push.",
		);
		await checked(
			host,
			`${git} --git-dir=${publish} push ${quote(url)} ${quote(`refs/heads/publish:refs/heads/${input.branch}`)}`,
			TRANSFER_FAILED,
			NETWORK_GIT_TIMEOUT_MS,
		);
	});
}
