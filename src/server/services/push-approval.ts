import type { ModelMessage } from "ai";
import { SessionItemId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import {
	PUSH_CARD_LIFETIME_MS,
	type PushAnswer,
	type PushCardState,
	pushApprovalOutcome,
	pushResultNotice,
} from "#/domain/push-approval";
import {
	type PushApprovalItem,
	type SessionItem,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import { hubTopic } from "#/domain/user-hub";
import {
	type AgentSessionRecord,
	agentSessionForOwner,
	agentSessionMetadataForOwner,
	sessionItemForOwner,
} from "../adapters/agent-sessions";
import { replaceIdleSessionItems } from "../adapters/background-command-sessions";
import { database } from "../adapters/database";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import {
	gitPushRequests,
	type PushRequestRecord,
} from "../adapters/git-push-requests";
import {
	branchHasCommitsBeyond,
	repositoryBranchSha,
} from "../adapters/github";
import type { GitTransferHost } from "../adapters/github/git-broker";
import { pushProxiedRepository } from "../adapters/github/git-proxy-transfer";
import { githubInstallationAccessToken } from "../adapters/github/installation-token";
import { repositoryDirectory } from "../adapters/repository-setup";
import { noteUserHub } from "../adapters/user-hub-notes";

export const PUSH_APPROVAL_UNAVAILABLE =
	"This push card is no longer available.";
export const MAIN_MOVED = (branch: string) =>
	`${branch} has moved; ask the agent to rebase`;
export const BRANCH_MOVED =
	"the branch has newer commits; ask the agent to request again";
/** A Push whose server push never answered (a restart) is given up after this long. */
const PUSH_STALLED_MS = 5 * 60_000;

/** The chat's workspace for an approved push: its checkout and a way to run git there. */
export type PushWorkspace = {
	host: GitTransferHost;
	directory: string;
};

/** What the card's server side reads and does; tests replace each. */
export type PushApprovalDependencies = {
	requests: Pick<
		typeof gitPushRequests,
		| "record"
		| "newerRefused"
		| "claimPush"
		| "answer"
		| "claimUnnoticed"
		| "releaseNotice"
	>;
	/** The chat with its whole transcript: only when notices are written back (rare). */
	session(
		userId: string,
		sessionId: string,
	): Promise<AgentSessionRecord | null>;
	/**
	 * The chat's row without its transcript, and one of its push cards by id:
	 * answering a card reads these instead of the transcript. Absent: `session`.
	 */
	metadata?(
		userId: string,
		sessionId: string,
	): Promise<AgentSessionRecord | null>;
	card?(userId: string, sessionId: string, itemId: string): Promise<unknown>;
	/** The project repository's installation; null when it left the project. */
	installation(
		userId: string,
		request: PushRequestRecord,
	): Promise<number | null>;
	/** The default branch's commit on GitHub now; null when it is not there. */
	remoteBranchSha(
		installationId: number,
		request: PushRequestRecord,
	): Promise<string | null>;
	/**
	 * Whether the chat's own branch on GitHub has commits beyond the approved
	 * one (a later turn committed and published, or the agent pushed). Reads
	 * GitHub only, so showing a card never wakes the chat's machine.
	 */
	chatBranchAdvanced(
		installationId: number,
		request: PushRequestRecord,
		branch: string,
	): Promise<boolean>;
	workspace(
		session: AgentSessionRecord,
		request: PushRequestRecord,
	): Promise<PushWorkspace | null>;
	push(
		host: GitTransferHost,
		input: Parameters<typeof pushProxiedRepository>[1],
	): Promise<void>;
	replaceIdleItems(
		userId: string,
		sessionId: string,
		expected: unknown,
		next: readonly SessionItem[],
	): Promise<boolean>;
	now(): number;
};

type CardInput = { userId: string; sessionId: string; itemId: string };

function shortSha(commit: string) {
	return commit.slice(0, 7);
}

function stateOf(request: PushRequestRecord): PushCardState {
	return request.answer
		? { answer: request.answer, detail: request.answerDetail ?? "" }
		: { answer: "pending" };
}

async function cardRequest(input: CardInput, deps: PushApprovalDependencies) {
	const session = await (deps.metadata ?? deps.session)(
		input.userId,
		input.sessionId,
	);
	if (!session) throw new Error(PUSH_APPROVAL_UNAVAILABLE);
	const held = deps.card
		? [await deps.card(input.userId, input.sessionId, input.itemId)]
		: session.items;
	const card = sessionItemsFromUnknown(held).find(
		(item): item is PushApprovalItem =>
			item.id === input.itemId && item.kind === "pushApproval",
	);
	const request = card
		? await deps.requests.record(input.userId, card.requestId)
		: null;
	if (!card || !request || request.sessionId !== session.id)
		throw new Error(PUSH_APPROVAL_UNAVAILABLE);
	return { session, card, request };
}

/**
 * Why a pending card can no longer be pushed, from what needs no workspace:
 * its age, a newer refused push of the branch, and the default branch on
 * GitHub having moved past the commit's base.
 */
async function staleness(
	userId: string,
	session: AgentSessionRecord,
	request: PushRequestRecord,
	deps: PushApprovalDependencies,
): Promise<{ answer: PushAnswer; detail: string } | null> {
	const posted = (request.requestedAt ?? request.createdAt).getTime();
	if (deps.now() - posted > PUSH_CARD_LIFETIME_MS)
		return { answer: "expired", detail: "no answer within 24 hours" };
	if (await deps.requests.newerRefused(userId, request))
		return { answer: "outdated", detail: BRANCH_MOVED };
	const installation = await deps.installation(userId, request);
	if (!installation)
		return {
			answer: "outdated",
			detail: "the repository is no longer in this project",
		};
	const remote = await deps.remoteBranchSha(installation, request);
	if (remote !== request.oldId)
		return { answer: "outdated", detail: MAIN_MOVED(request.branch) };
	// A later turn's commits reach GitHub on the chat's own branch.
	const chatBranch = session.workingBranch || session.taskBranch;
	if (
		chatBranch &&
		chatBranch !== request.branch &&
		(await deps.chatBranchAdvanced(installation, request, chatBranch))
	)
		return { answer: "outdated", detail: BRANCH_MOVED };
	return null;
}

/** Settles the card (once) and posts the chat's notice. */
async function settle(
	userId: string,
	session: AgentSessionRecord,
	request: PushRequestRecord,
	result: { answer: PushAnswer; detail: string },
	deps: PushApprovalDependencies,
): Promise<PushCardState> {
	if (
		!(await deps.requests.answer(
			userId,
			request.id,
			result.answer,
			result.detail,
		))
	) {
		const current = await deps.requests.record(userId, request.id);
		return current ? stateOf(current) : { answer: "pending" };
	}
	// Every open card of this user checks again: this one is settled, and a
	// push may have outdated another.
	noteUserHub(userId, [hubTopic.push]);
	await postPushResultNotices(userId, session.id, deps).catch((error) => {
		console.warn("A push result notice was not posted.", {
			error: error instanceof Error ? error.message : "unknown",
		});
	});
	return result;
}

/**
 * The card's state when it is shown. A pending card is checked here, so an
 * expired or outdated one says so (and is settled, never pushed later).
 */
export async function pushApprovalCardStatus(
	input: CardInput,
	deps: PushApprovalDependencies = pushApprovalDependencies,
): Promise<PushCardState> {
	const { session, request } = await cardRequest(input, deps);
	if (request.answer) return stateOf(request);
	if (request.approvedAt) {
		if (deps.now() - request.approvedAt.getTime() < PUSH_STALLED_MS)
			return { answer: "pending" };
		return settle(
			input.userId,
			session,
			request,
			{
				answer: "failed",
				detail: "the push did not finish; ask the agent to request again",
			},
			deps,
		);
	}
	const stale = await staleness(input.userId, session, request, deps);
	return stale
		? settle(input.userId, session, request, stale, deps)
		: stateOf(request);
}

/** Shell that says whether the approved commit can still fast-forward the default branch. */
export function pushFreshnessCommand(input: {
	directory: string;
	commit: string;
	remote: string;
}) {
	const objectId = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
	if (!objectId.test(input.commit) || !objectId.test(input.remote))
		throw new Error("Invalid commit id.");
	return `cd ${quote(input.directory)} || exit 3
git cat-file -e ${input.commit}^{commit} 2>/dev/null || { echo missing; exit 0; }
head=$(git rev-parse HEAD 2>/dev/null)
if [ "$head" != ${input.commit} ] && git merge-base --is-ancestor ${input.commit} "$head" 2>/dev/null; then echo newer; exit 0; fi
git merge-base --is-ancestor ${input.remote} ${input.commit} 2>/dev/null || { echo diverged; exit 0; }
echo fresh`;
}

/**
 * The card's Push: the server pushes exactly the approved commit to the
 * default branch (a one-time grant naming that commit), never forced. The
 * server checks age, freshness and fast-forward itself; any refusal leaves
 * the branch untouched and the card says why.
 */
export async function pushApprovedChange(
	input: CardInput,
	deps: PushApprovalDependencies = pushApprovalDependencies,
): Promise<PushCardState> {
	const { session, request } = await cardRequest(input, deps);
	if (request.answer) return stateOf(request);
	const stale = await staleness(input.userId, session, request, deps);
	if (stale) return settle(input.userId, session, request, stale, deps);
	if (!(await deps.requests.claimPush(input.userId, request.id)))
		return { answer: "pending" };
	const fail = (detail: string) =>
		settle(input.userId, session, request, { answer: "failed", detail }, deps);
	try {
		const installation = await deps.installation(input.userId, request);
		const workspace = await deps.workspace(session, request);
		if (!installation || !workspace)
			return fail("the chat's workspace is not available");
		const fresh = await workspace.host.exec(
			pushFreshnessCommand({
				directory: workspace.directory,
				commit: request.newId,
				remote: request.oldId,
			}),
			30_000,
		);
		const verdict = fresh.exitCode === 0 ? fresh.stdout.trim() : "error";
		if (verdict === "newer" || verdict === "diverged")
			return settle(
				input.userId,
				session,
				request,
				{
					answer: "outdated",
					detail:
						verdict === "newer" ? BRANCH_MOVED : MAIN_MOVED(request.branch),
				},
				deps,
			);
		if (verdict !== "fresh")
			return fail(
				verdict === "missing"
					? "the commit is no longer in the workspace"
					: "could not check the workspace's checkout",
			);
		try {
			await deps.push(workspace.host, {
				userId: input.userId,
				projectId: request.projectId,
				owner: request.owner,
				name: request.name,
				branch: request.branch,
				installationId: installation,
				directory: workspace.directory,
				commit: request.newId,
			});
		} catch {
			// GitHub refuses a push that is not a fast-forward: main moved meanwhile.
			const remote = await deps
				.remoteBranchSha(installation, request)
				.catch(() => null);
			return remote !== request.oldId
				? settle(
						input.userId,
						session,
						request,
						{ answer: "outdated", detail: MAIN_MOVED(request.branch) },
						deps,
					)
				: fail("GitHub refused the push");
		}
		return settle(
			input.userId,
			session,
			request,
			{ answer: "pushed", detail: shortSha(request.newId) },
			deps,
		);
	} catch (error) {
		console.warn("An approved push failed.", {
			error: error instanceof Error ? error.message : "unknown",
		});
		return fail("the push could not run");
	}
}

/** The card's Cancel: nothing is pushed and no turn starts; the chat notes it. */
export async function cancelPushApproval(
	input: CardInput,
	deps: PushApprovalDependencies = pushApprovalDependencies,
): Promise<PushCardState> {
	const { session, request } = await cardRequest(input, deps);
	if (request.answer) return stateOf(request);
	if (request.approvedAt) return { answer: "pending" };
	return settle(
		input.userId,
		session,
		request,
		{ answer: "cancelled", detail: "" },
		deps,
	);
}

/** Notice items for answered cards; the running turn's agent also reads them. */
function noticeItems(rows: readonly PushRequestRecord[]): SessionItem[] {
	return rows.flatMap((row) =>
		row.answer
			? [
					{
						kind: "notice" as const,
						id: SessionItemId(`push-result:${row.id}`),
						message: pushResultNotice(
							{ repo: `${row.owner}/${row.name}`, branch: row.branch },
							{ answer: row.answer, detail: row.answerDetail ?? "" },
						),
						pushResult: {
							requestId: row.id,
							answer: row.answer,
							detail: row.answerDetail ?? "",
						},
					},
				]
			: [],
	);
}

/**
 * Puts answered cards' notices into an idle chat now (never starting a
 * turn). A chat whose turn runs, or that changed meanwhile, gets them from
 * its turn's next step (withPushResultNotices).
 */
export async function postPushResultNotices(
	userId: string,
	sessionId: string,
	deps: PushApprovalDependencies = pushApprovalDependencies,
) {
	const rows = await deps.requests.claimUnnoticed(userId, sessionId);
	if (!rows.length) return;
	const notices = noticeItems(rows);
	for (let attempt = 0; attempt < 3; attempt++) {
		const session = await deps.session(userId, sessionId);
		if (!session || session.turnStatus === "running") break;
		const items = sessionItemsFromUnknown(session.items);
		const fresh = notices.filter(
			(notice) => !items.some((item) => item.id === notice.id),
		);
		if (
			await deps.replaceIdleItems(userId, sessionId, session.items, [
				...items,
				...fresh,
			])
		)
			return;
	}
	await Promise.all(
		rows.map((row) => deps.requests.releaseNotice(userId, row.id)),
	);
}

/** A running turn's step adds answered cards' notices to the chat and tells the agent. */
export async function withPushResultNotices(
	input: {
		userId: string;
		sessionId: string;
		items: SessionItem[];
		messages: ModelMessage[];
	},
	requests: Pick<typeof gitPushRequests, "claimUnnoticed"> = gitPushRequests,
) {
	// Most steps have no card waiting: they read nothing.
	if (
		!input.items.some(
			(item) =>
				item.kind === "pushApproval" &&
				pushApprovalOutcome(input.items, item.id).answer === "pending",
		)
	)
		return null;
	const rows = await requests.claimUnnoticed(input.userId, input.sessionId);
	const notices = noticeItems(rows).filter(
		(notice) => !input.items.some((item) => item.id === notice.id),
	);
	if (!notices.length) return null;
	return {
		items: [...input.items, ...notices],
		messages: [
			...input.messages,
			{
				role: "user" as const,
				content: notices
					.map((notice) => (notice.kind === "notice" ? notice.message : ""))
					.join("\n"),
			},
		],
	};
}

export const pushApprovalDependencies: PushApprovalDependencies = {
	requests: gitPushRequests,
	session: (userId, sessionId) => agentSessionForOwner(userId, sessionId),
	metadata: async (userId, sessionId) =>
		(await agentSessionMetadataForOwner(
			userId,
			sessionId,
		)) as AgentSessionRecord | null,
	card: (userId, sessionId, itemId) =>
		sessionItemForOwner(userId, sessionId, itemId, "pushApproval"),
	async installation(userId, request) {
		const result = await database().query<{ installationId: number }>(
			`select r.installation_id::float8 as "installationId"
			 from project_repository r join project p on p.id=r.project_id
			 where p.id=$1 and p.user_id=$2 and lower(r.full_name)=lower($3) limit 1`,
			[request.projectId, userId, `${request.owner}/${request.name}`],
		);
		return result.rows[0]?.installationId ?? null;
	},
	async remoteBranchSha(installationId, request) {
		const token = await githubInstallationAccessToken(installationId, {
			repositoryNames: [request.name],
			contents: "read",
		});
		return repositoryBranchSha(
			token,
			`${request.owner}/${request.name}`,
			request.branch,
		);
	},
	async chatBranchAdvanced(installationId, request, branch) {
		const token = await githubInstallationAccessToken(installationId, {
			repositoryNames: [request.name],
			contents: "read",
		});
		return branchHasCommitsBeyond(
			token,
			`${request.owner}/${request.name}`,
			request.newId,
			branch,
		);
	},
	async workspace(session, request) {
		if (!session.providerRef) return null;
		const runtime = workspaceRuntimeFromEnv();
		const providerRef = await runtime.recover(session.providerRef);
		return {
			directory: repositoryDirectory(`${request.owner}/${request.name}`),
			host: {
				exec: (command, timeout) =>
					runtime.exec(providerRef, ["bash", "-lc", command], {}, timeout),
				writeTextFile: (path, contents) =>
					runtime.writeTextFile(providerRef, path, contents),
			},
		};
	},
	push: (host, push) => pushProxiedRepository(host, push),
	replaceIdleItems: (userId, sessionId, expected, next) =>
		replaceIdleSessionItems(userId, sessionId, expected, next),
	now: () => Date.now(),
};
