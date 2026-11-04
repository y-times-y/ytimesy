import { edgeSigningSecret } from "#/domain/edge-signing-secret";
import { fetchedBranchCommand } from "#/domain/git-branch-switch";
import { issueGitProxyGrant } from "#/domain/github-git-proxy";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { redactSecrets } from "#/domain/redact-secrets";
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
	const secret = edgeSigningSecret("YTIMESY_GIT_PROXY_SECRET", "git-proxy");
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

/** The last lines of a command's stderr, without URLs or credentials. */
function stderrTail(result: { stderr?: unknown }, limit: number) {
	return redactSecrets(
		String(result.stderr ?? "")
			.replace(/https?:\/\/\S+/g, "<url>")
			.trim()
			.split("\n")
			.slice(-3)
			.join(" | "),
		limit,
	);
}

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
			stderr: stderrTail(result, 400),
		});
		throw new Error(failure);
	}
	return result.stdout.trim();
}

/**
 * Only Git's own "not a valid branch name" is a rejected name; any other
 * failure (the command could not run, timed out, Git refused the directory)
 * says so with its exit code and a short cause.
 */
export async function checkBranchNames(
	host: GitTransferHost,
	branches: readonly string[],
) {
	const result = await host.exec(
		branches
			.map((branch) => `git check-ref-format --branch ${quote(branch)}`)
			.join(" && "),
		15_000,
	);
	if (result.exitCode === 0) return;
	const cause = stderrTail(result, 160);
	if (/is not a valid branch name/.test(cause))
		throw new Error("Workspace Git rejected the branch name.");
	console.warn("Workspace Git command failed", {
		failure: "check-ref-format",
		exitCode: result.exitCode,
		stderr: stderrTail(result, 400),
	});
	throw new Error(
		`Workspace Git could not check the branch name (exit ${result.exitCode}${cause ? `: ${cause}` : ""}).`,
	);
}

/**
 * Private temporary Git config carries only an expiring capability; origin
 * remains credential-free. A write capability updates only `input.branch`,
 * once, and the proxy refuses deletes and every other ref.
 */
/** The private Git config that carries a grant: its headers, no redirects. */
function proxyGitConfig(origin: string, headers: Record<string, string>) {
	return `[http ${JSON.stringify(`${origin}/`)}]\n\tfollowRedirects = false\n${Object.entries(
		headers,
	)
		.map(
			([name, value]) =>
				`\textraHeader = ${JSON.stringify(`${name}: ${value}`)}`,
		)
		.join("\n")}\n`;
}

const proxyGit = (config: string) =>
	`env GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=${config} GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https git -c core.hooksPath=/dev/null -c protocol.ext.allow=never -c fetch.fsckObjects=true -c transfer.fsckObjects=true`;

/** Exit codes of the one-command clone, one per step that can fail. */
const CLONE_EXIT = {
	branchName: 64,
	prepare: 65,
	create: 66,
	fetch: 67,
	checkout: 68,
	dirty: 69,
	status: 70,
} as const;

/**
 * A new checkout, or a clean one fast-forwarded, in one guest command:
 * branch names, the checkout's state, the private config (its grant arrives
 * in the environment, never in the command text), fetch, checkout and
 * cleanup. The same steps as below, about six guest round trips fewer; each
 * failure keeps its own message, and a dirty checkout is still "dirty".
 */
async function receiveProxiedRepositoryInOneCommand(
	execWithEnv: NonNullable<GitTransferHost["execWithEnv"]>,
	input: Repository & {
		destination: string;
		workingBranch?: string;
		mode: "clone" | "update";
		pinnedRevision?: string;
	},
) {
	const config = gitProxyConfiguration();
	if (!config || !input.userId || !input.projectId)
		throw new Error("Owner-scoped Git proxy configuration is missing.");
	const branch = input.workingBranch || input.branch;
	const headers = await issueGitProxyGrant(config.secret, {
		userId: input.userId,
		projectId: input.projectId,
		owner: input.owner,
		name: input.name,
		installationId: Number(input.installationId),
		access: "read",
	});
	const dest = quote(input.destination);
	const url = `${config.origin}/git/${input.owner}/${input.name}.git`;
	const script = `set -u
for name in ${[input.branch, branch].map(quote).join(" ")}; do
  git check-ref-format --branch "$name" >/dev/null || exit ${CLONE_EXIT.branchName}
done
temporary=$(umask 077; mktemp -d /tmp/ytimesy-git-proxy-XXXXXXXX) || exit ${CLONE_EXIT.prepare}
trap 'rm -rf "$temporary"' EXIT
(umask 077; printf '%s' "$YTIMESY_GIT_PROXY_CONFIG" > "$temporary/config") || exit ${CLONE_EXIT.prepare}
unset YTIMESY_GIT_PROXY_CONFIG
${
	input.mode === "clone"
		? `{ test ! -e ${dest} && mkdir -p ${dest} && git -C ${dest} init -q; } || exit ${CLONE_EXIT.create}`
		: `state=$(git -C ${dest} status --porcelain) || exit ${CLONE_EXIT.status}\n[ -z "$state" ] || exit ${CLONE_EXIT.dirty}`
}
${proxyGit('"$temporary/config"')} -C ${dest} fetch --no-tags ${quote(url)} ${quote(`refs/heads/${input.branch}`)} || exit ${CLONE_EXIT.fetch}
(set -eu
${fetchedBranchCommand({
	directory: input.destination,
	branch: input.branch,
	workingBranch: branch,
	mode: input.mode,
	originUrl: `https://github.com/${input.owner}/${input.name}.git`,
	pinnedRevision: input.pinnedRevision,
})}
) || exit ${CLONE_EXIT.checkout}`;
	const result = await execWithEnv(
		script,
		{ YTIMESY_GIT_PROXY_CONFIG: proxyGitConfig(config.origin, headers) },
		// The fetch and the checkout had two minutes each.
		2 * NETWORK_GIT_TIMEOUT_MS,
	);
	if (result.exitCode === 0) return "updated";
	if (result.exitCode === CLONE_EXIT.dirty) return "dirty";
	const failure =
		result.exitCode === CLONE_EXIT.status
			? "Workspace Git could not read the checkout's status."
			: result.exitCode === CLONE_EXIT.branchName
				? "Workspace Git rejected the branch name."
				: result.exitCode === CLONE_EXIT.prepare
					? "Workspace Git could not prepare its private configuration."
					: result.exitCode === CLONE_EXIT.create
						? "Workspace Git could not create the checkout."
						: result.exitCode === CLONE_EXIT.fetch
							? TRANSFER_FAILED
							: result.exitCode === CLONE_EXIT.checkout
								? input.mode === "update"
									? "Workspace Git could not fast-forward the checkout to its branch."
									: "Workspace Git could not check out the fetched branch."
								: `Workspace Git could not fetch the repository (exit ${result.exitCode}).`;
	console.warn("Workspace Git command failed", {
		failure,
		exitCode: result.exitCode,
		stderr: stderrTail(result, 400),
	});
	throw new Error(failure);
}

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
			proxyGitConfig(config.origin, headers),
		);
		const git = proxyGit(quote(`${temporary}/config`));
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
		/** See fetchedBranchCommand. */
		pinnedRevision?: string;
	},
) {
	if (input.mode !== "switch" && host.execWithEnv)
		return receiveProxiedRepositoryInOneCommand(host.execWithEnv.bind(host), {
			...input,
			mode: input.mode,
		});
	const dest = quote(input.destination);
	const branch = input.workingBranch || input.branch;
	await checkBranchNames(host, [input.branch, branch]);
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
				pinnedRevision: input.pinnedRevision,
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
		/**
		 * Pushes exactly this commit (an approved push to a default branch);
		 * the grant names it, so the proxy refuses any other.
		 */
		commit?: string;
	},
) {
	if (
		input.revision &&
		!/^refs\/ytimesy\/turn-commits\/[a-f0-9]{64}$/.test(input.revision)
	)
		throw new Error("Invalid completed-turn revision.");
	if (input.commit && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commit))
		throw new Error("Invalid commit to push.");
	const config = gitProxyConfiguration();
	if (!config || !input.userId || !input.projectId)
		throw new Error("Owner-scoped Git proxy configuration is missing.");
	// Three guest round trips: the branch name and a private directory, the
	// grant's config file (never in a command's text), then preparing,
	// pushing and cleaning up in one command.
	const [headers, prepared] = await Promise.all([
		issueGitProxyGrant(config.secret, {
			userId: input.userId,
			projectId: input.projectId,
			owner: input.owner,
			name: input.name,
			installationId: Number(input.installationId),
			access: "write",
			branch: input.branch,
			...(input.commit ? { commit: input.commit } : {}),
		}),
		host.exec(
			`git check-ref-format --branch ${quote(input.branch)} >/dev/null || exit ${PUSH_EXIT.branchName}
umask 077; mktemp -d /tmp/ytimesy-git-proxy-XXXXXXXX || exit ${PUSH_EXIT.prepare}`,
			15_000,
		),
	]);
	if (prepared.exitCode !== 0) {
		const cause = stderrTail(prepared, 160);
		if (
			prepared.exitCode === PUSH_EXIT.branchName &&
			/is not a valid branch name/.test(cause)
		)
			throw new Error("Workspace Git rejected the branch name.");
		console.warn("Workspace Git command failed", {
			failure: "push-prepare",
			exitCode: prepared.exitCode,
			stderr: stderrTail(prepared, 400),
		});
		throw new Error(
			prepared.exitCode === PUSH_EXIT.branchName
				? `Workspace Git could not check the branch name (exit ${prepared.exitCode}${cause ? `: ${cause}` : ""}).`
				: "Workspace Git could not prepare its private configuration.",
		);
	}
	const temporary = prepared.stdout.trim();
	if (!/^\/tmp\/ytimesy-git-proxy-[a-zA-Z0-9]+$/.test(temporary))
		throw new Error("Invalid private Git configuration directory.");
	const url = `${config.origin}/git/${input.owner}/${input.name}.git`;
	let ran = false;
	try {
		await host.writeTextFile(
			`${temporary}/config`,
			proxyGitConfig(config.origin, headers),
		);
		const git = proxyGit(quote(`${temporary}/config`));
		// The checkout's own config is the agent's to write (http.proxy,
		// url.*.insteadOf, http.curloptResolve...), so the push runs from a
		// fresh repository that borrows the checkout's objects but none of
		// its config.
		const directory = quote(input.directory);
		const publish = quote(`${temporary}/push.git`);
		const result = await host.exec(
			`set -u
trap 'rm -rf ${quote(temporary)}' EXIT
(set -eu
objects=$(cd ${directory} && cd "$(git rev-parse --git-path objects)" && pwd -P)
commit=$(git -C ${directory} rev-parse --verify ${quote(`${input.commit || input.revision || "HEAD"}^{commit}`)})
${git} init -q --bare ${publish}
printf '%s\n' "$objects" > ${quote(`${temporary}/push.git/objects/info/alternates`)}
${git} --git-dir=${publish} update-ref refs/heads/publish "$commit") || exit ${PUSH_EXIT.commit}
${git} --git-dir=${publish} push ${quote(url)} ${quote(`refs/heads/publish:refs/heads/${input.branch}`)} || exit ${PUSH_EXIT.push}`,
			NETWORK_GIT_TIMEOUT_MS,
		);
		ran = true;
		if (result.exitCode !== 0) {
			const failure =
				result.exitCode === PUSH_EXIT.commit
					? "Workspace Git could not prepare the commit to push."
					: TRANSFER_FAILED;
			console.warn("Workspace Git command failed", {
				failure,
				exitCode: result.exitCode,
				stderr: stderrTail(result, 400),
			});
			throw new Error(failure);
		}
	} finally {
		// The push command removes its directory itself; this is for when it never ran.
		if (!ran)
			await host
				.exec(`rm -rf ${quote(temporary)}`, 10_000)
				.catch(() => undefined);
	}
}

/** Exit codes of the push's guest commands, one per step that can fail. */
const PUSH_EXIT = {
	branchName: 64,
	prepare: 65,
	commit: 66,
	push: 67,
} as const;
