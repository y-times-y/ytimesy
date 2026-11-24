import { edgeSigningSecret } from "#/domain/edge-signing-secret";
import {
	DIRTY_BRANCH_SWITCH_MESSAGE,
	fetchedBranchCommand,
} from "#/domain/git-branch-switch";
import { issueGitProxyGrant } from "#/domain/github-git-proxy";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { redactSecrets } from "#/domain/redact-secrets";
import {
	MANAGED_GIT_ENV,
	MANAGED_GIT_TRAILER,
	managedPushIdentityCheck,
} from "../managed-git-identity";
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

/**
 * GitHub refuses a push from an app that adds or changes a workflow file
 * (.github/workflows/...) without the Workflows permission, which ytimesy's
 * app does not have.
 */
const WORKFLOW_PUSH_REFUSED =
	"GitHub blocked the push: the ytimesy app may not change workflow files under .github/workflows. Remove that file from the commit, or add it yourself.";
const WORKFLOW_PUSH_REFUSED_PATTERN =
	/without\s+`?workflows`?\s+permission|workflow[^\n]{0,120}permission/i;

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

/**
 * A busy or just-woken guest can take far longer than a normal command to
 * answer `git status` (production, 2026-11-08: two chats failed with exit 124
 * and no stderr, the 15 s budget). A read is safe to repeat, so a timeout is
 * retried with a larger budget before it counts as a failure.
 */
const STATUS_READ_BUDGETS_MS = [30_000, 60_000, 120_000] as const;
const COMMAND_TIMED_OUT_EXIT = 124;

async function readCheckoutStatus(host: GitTransferHost, dest: string) {
	const command = `git -C ${dest} status --porcelain`;
	for (const [attempt, budget] of STATUS_READ_BUDGETS_MS.entries()) {
		const started = Date.now();
		const result = await host.exec(command, budget);
		if (result.exitCode === 0) return result.stdout.trim();
		const timedOut = result.exitCode === COMMAND_TIMED_OUT_EXIT;
		console.warn("Workspace Git command failed", {
			failure: "Workspace Git could not read the checkout's status.",
			exitCode: result.exitCode,
			attempt: attempt + 1,
			budgetMs: budget,
			elapsedMs: Date.now() - started,
			stderr: stderrTail(result, 400),
		});
		if (!timedOut || attempt === STATUS_READ_BUDGETS_MS.length - 1) break;
	}
	throw new Error("Workspace Git could not read the checkout's status.");
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
		const dirty = await readCheckoutStatus(host, dest);
		if (dirty && input.mode === "switch")
			throw new Error(DIRTY_BRANCH_SWITCH_MESSAGE);
		if (dirty) return "dirty";
	}
	return withProxyGit(host, input, "read", async (git, url) => {
		await checked(
			host,
			`set -eu\n${input.mode === "clone" ? `test ! -e ${dest}\nmkdir -p ${dest}\ngit -C ${dest} init` : `test -z "$(git -C ${dest} status --porcelain)"`}`,
			input.mode === "clone"
				? "Workspace Git could not create the checkout."
				: "Workspace Git found uncommitted changes in the checkout.",
			input.mode === "clone" ? undefined : STATUS_READ_BUDGETS_MS[1],
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

type PushInput = Repository & {
	directory: string;
	baseBranch?: string;
	revision?: string;
	/**
	 * Pushes exactly this commit (an approved push to a default branch);
	 * the grant names it, so the proxy refuses any other.
	 */
	commit?: string;
};

/** GitHub refused the push because the branch has commits the checkout lacks. */
class PushNotFastForward extends Error {}

/**
 * What a rejected non-fast-forward push says. Only the last lines of stderr
 * are kept, and Git ends that rejection with its "git pull" / "fast-forwards"
 * hints.
 */
const NOT_FAST_FORWARD_PATTERN =
	/non-fast-forward|fetch first|git pull|fast-forwards/i;

const BRANCH_DIVERGED =
	"Workspace Git could not merge the chat's branch with newer commits already on GitHub (conflicting changes). Merge or rebase the branch from GitHub in the workspace, then send a message to push again.";
const BRANCH_KEPT_MOVING =
	"The chat's branch on GitHub changed again while ytimesy was merging it. Send a message to push again.";

/**
 * Pushes the turn's commit to the chat's branch. When the branch on GitHub
 * has commits the checkout lacks (a rebase or amend after an earlier push,
 * or a push from elsewhere), the push used to fail the same way every turn.
 * A chat's turn publication now fetches the branch, merges it into the
 * commit being published (history kept, nothing force-pushed) and pushes
 * that, with a fresh grant: the proxy spends a write grant on its first push
 * request, even a rejected one.
 */
export async function pushProxiedRepository(
	host: GitTransferHost,
	input: PushInput,
) {
	try {
		return await pushOnce(host, input, false);
	} catch (error) {
		if (!(error instanceof PushNotFastForward) || !input.revision) throw error;
		console.warn("Workspace Git push rejected; merging the remote branch", {
			branch: input.branch,
		});
		await pushOnce(host, input, true);
		// The branch on GitHub now holds the merge (or already held the
		// commit). Without it in the checkout, the next turn's commit would
		// diverge again and add another merge commit.
		await catchUpCheckout(host, input).catch((cause: unknown) => {
			console.warn("Workspace Git could not catch the checkout up", {
				branch: input.branch,
				cause: cause instanceof Error ? cause.message : "unknown",
			});
		});
	}
}

/**
 * Fast-forwards the checkout to the branch it just pushed. A checkout with
 * uncommitted changes, or one that moved on, is left as it is: the update
 * only ever fast-forwards.
 */
function catchUpCheckout(host: GitTransferHost, input: PushInput) {
	return receiveProxiedRepository(host, {
		owner: input.owner,
		name: input.name,
		branch: input.branch,
		workingBranch: input.branch,
		installationId: input.installationId,
		userId: input.userId,
		projectId: input.projectId,
		destination: input.directory,
		mode: "update",
	});
}

async function pushOnce(
	host: GitTransferHost,
	input: PushInput,
	reconcile: boolean,
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
${reconcile ? mergeRemoteBranchScript(git, publish, url, input.branch) : ""}${git} --git-dir=${publish} fetch -q --no-tags ${quote(url)} 'refs/heads/*:refs/ytimesy/upstream/*' || exit ${PUSH_EXIT.prepare}
${managedPushIdentityCheck(`${git} --git-dir=${publish}`, "refs/heads/publish", "--glob=refs/ytimesy/upstream/*", PUSH_EXIT.identity)}
${git} --git-dir=${publish} push ${quote(url)} ${quote(`refs/heads/publish:refs/heads/${input.branch}`)} || exit ${PUSH_EXIT.push}`,
			NETWORK_GIT_TIMEOUT_MS,
		);
		ran = true;
		if (result.exitCode !== 0) {
			const stderr = stderrTail(result, 400);
			if (
				!reconcile &&
				result.exitCode === PUSH_EXIT.push &&
				NOT_FAST_FORWARD_PATTERN.test(stderr)
			) {
				console.warn("Workspace Git command failed", {
					failure: TRANSFER_FAILED,
					exitCode: result.exitCode,
					stderr,
				});
				throw new PushNotFastForward(TRANSFER_FAILED);
			}
			if (reconcile && result.exitCode === PUSH_EXIT.diverged) {
				console.warn("Workspace Git command failed", {
					failure: BRANCH_DIVERGED,
					exitCode: result.exitCode,
					stderr,
				});
				throw new Error(BRANCH_DIVERGED);
			}
			if (
				reconcile &&
				result.exitCode === PUSH_EXIT.push &&
				NOT_FAST_FORWARD_PATTERN.test(stderr)
			) {
				console.warn("Workspace Git command failed", {
					failure: BRANCH_KEPT_MOVING,
					exitCode: result.exitCode,
					stderr,
				});
				throw new Error(BRANCH_KEPT_MOVING);
			}
			const failure =
				result.exitCode === PUSH_EXIT.identity
					? "Push refused: an unpublished commit does not have the managed Git identity."
					: result.exitCode === PUSH_EXIT.commit
						? "Workspace Git could not prepare the commit to push."
						: WORKFLOW_PUSH_REFUSED_PATTERN.test(stderr)
							? WORKFLOW_PUSH_REFUSED
							: TRANSFER_FAILED;
			console.warn("Workspace Git command failed", {
				failure,
				exitCode: result.exitCode,
				stderr,
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
	diverged: 68,
	identity: 69,
} as const;

/**
 * Guest shell run before the retry's push: fetches the branch, and when it
 * has commits the published commit lacks, merges it in without a working
 * tree (`git merge-tree`). A remote that already contains the commit needs
 * no push (exit 0); a conflicting merge, or a Git too old for `merge-tree
 * --write-tree`, exits with PUSH_EXIT.diverged.
 */
export function mergeRemoteBranchScript(
	git: string,
	publish: string,
	url: string,
	branch: string,
) {
	const remoteRef = "refs/remotes/origin/chat";
	return `${git} --git-dir=${publish} fetch -q --no-tags ${quote(url)} ${quote(`refs/heads/${branch}:${remoteRef}`)} || exit ${PUSH_EXIT.push}
commit=$(${git} --git-dir=${publish} rev-parse --verify refs/heads/publish) || exit ${PUSH_EXIT.commit}
remote=$(${git} --git-dir=${publish} rev-parse --verify ${remoteRef}) || exit ${PUSH_EXIT.push}
if ${git} --git-dir=${publish} merge-base --is-ancestor "$commit" "$remote"; then exit 0; fi
if ! ${git} --git-dir=${publish} merge-base --is-ancestor "$remote" "$commit"; then
  tree=$(${git} --git-dir=${publish} merge-tree --write-tree --no-messages "$commit" "$remote") || exit ${PUSH_EXIT.diverged}
  merged=$(${MANAGED_GIT_ENV} ${git} --git-dir=${publish} commit-tree "$tree" -p "$commit" -p "$remote" -m "Merge remote changes into the chat's branch" -m ${quote(MANAGED_GIT_TRAILER)}) || exit ${PUSH_EXIT.diverged}
  ${git} --git-dir=${publish} update-ref refs/heads/publish "$merged" || exit ${PUSH_EXIT.commit}
fi
`;
}
