import { Effect } from "effect";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import {
	chatPath,
	type FailingCheck,
	pullRequestWakePrompt,
	wakeMessageId,
} from "#/domain/pull-request-wake";
import { UserActionRateLimited } from "#/domain/user-action-rate";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
	listAgentSessions,
	saveSessionWorkingBranch,
} from "../adapters/agent-sessions";
import { pullRequestWakeGitHub } from "../adapters/github/pull-request-wake-github";
import {
	bindPullRequestLinkSession,
	type ClaimedWake,
	claimPullRequestWake,
	finishPullRequestWake,
	type PullRequestLink,
	pullRequestLinkForOwner,
} from "../adapters/pull-request-links";
import { consumeUserAction } from "../adapters/user-action-rate";
import { openAgentSession } from "./agent-session-machine";
import { sendComposerMessage } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

/** A wake that must not be retried: it needs the person (or nothing at all). */
export class PullRequestWakeStopped extends Error {
	constructor(
		message: string,
		readonly status: "ignored" | "blocked",
	) {
		super(message);
		this.name = "PullRequestWakeStopped";
	}
}

const ignore = (message: string) =>
	new PullRequestWakeStopped(message, "ignored");
const block = (message: string) =>
	new PullRequestWakeStopped(message, "blocked");

/**
 * The root chat that works on the pull request's branch: the one GitHub
 * wake-ups already continue, else the chat that opened it or another chat on
 * that branch, else a new chat checked out on the branch.
 */
async function pullRequestChat(
	link: PullRequestLink,
	title: string,
): Promise<Omit<AgentSessionRecord, "items">> {
	// The wake reads the chat's id, runtime and model, never its transcript.
	const onBranch = (session: Omit<AgentSessionRecord, "items"> | null) =>
		session &&
		session.projectId === link.projectId &&
		!session.parentSessionId &&
		session.workingBranch === link.headRef
			? session
			: null;
	for (const id of [link.sessionId, link.originSessionId]) {
		const session = id
			? onBranch(await agentSessionMetadataForOwner(link.userId, id))
			: null;
		if (session) {
			if (session.id !== link.sessionId)
				await bindPullRequestLinkSession(link.id, session.id);
			return session;
		}
	}
	const chats = await listAgentSessions(link.userId, link.projectId);
	const existing = chats.find((chat) => onBranch(chat));
	if (existing) {
		await bindPullRequestLinkSession(link.id, existing.id);
		return existing;
	}
	const harness: AgentProviderId =
		chats[0]?.harness ?? DEFAULT_COMPOSER_HARNESS_ID;
	const opened = await openAgentSession({
		userId: link.userId,
		projectId: link.projectId,
		harness,
		title,
	});
	const chat = await saveSessionWorkingBranch(
		link.userId,
		opened.id,
		link.headRef,
		link.baseRef,
	);
	await bindPullRequestLinkSession(link.id, chat.id);
	return chat;
}

/**
 * Sends the message to the pull request's chat: it waits behind a running
 * turn, otherwise starts one. The message id is stable per wake, so a retried
 * delivery never sends twice.
 */
export async function wakePullRequestChat(
	machines: WorkspaceMachines,
	input: {
		link: PullRequestLink;
		title: string;
		text: string;
		messageId: string;
	},
) {
	const chat = await pullRequestChat(input.link, input.title);
	if (!chat.listedModelId)
		throw block(
			"The pull request's chat has no model selected. Pick a model in the chat and retry; no fallback was used.",
		);
	const view = await Effect.runPromise(
		sendComposerMessage(
			machines,
			{
				userId: input.link.userId,
				projectId: input.link.projectId,
				sessionId: chat.id,
				harnessId: chat.harness,
				createNew: false,
			},
			{
				text: input.text,
				modelId: chat.listedModelId,
				idempotencyKey: input.messageId,
			},
		),
	);
	if (view.connection.status === "failed")
		throw new Error(
			view.connection.message ||
				"The chat did not accept the message. Check its model connection.",
		);
	return { sessionId: chat.id };
}

async function failingChecksOrNone(
	github: Awaited<ReturnType<typeof pullRequestWakeGitHub>>,
	headSha: string,
): Promise<FailingCheck[]> {
	// Checks read is optional for a click: the chat can still look itself.
	return github.failingChecks(headSha).catch(() => []);
}

/** "Fix with ytimesy" from the pull request description, by its signed-in owner. */
export async function startPullRequestFix(
	machines: WorkspaceMachines,
	input: {
		userId: string;
		projectId: string;
		linkId: string;
		requestId: string;
		note?: string;
	},
) {
	const link = await pullRequestLinkForOwner(
		input.userId,
		input.projectId,
		input.linkId,
	);
	if (!link) throw new Response("Pull request not found.", { status: 404 });
	const github = await pullRequestWakeGitHub(link);
	const pull = await github.pull();
	if (!pull.open)
		throw new Response("This pull request is closed.", { status: 409 });
	if (!pull.sameRepository || pull.headRef !== link.headRef)
		throw new Response("This pull request's branch has changed.", {
			status: 409,
		});
	const checks = await failingChecksOrNone(github, pull.headSha);
	try {
		return await wakePullRequestChat(machines, {
			link,
			title: `Fix PR #${pull.number}`,
			text: pullRequestWakePrompt({
				kind: "fix",
				pull,
				checks,
				note: input.note ?? null,
			}),
			messageId: wakeMessageId(`fix:${link.id}:${input.requestId}`),
		});
	} catch (error) {
		if (error instanceof PullRequestWakeStopped)
			throw new Response(error.message, { status: 409 });
		throw error;
	}
}

/** Re-reads the event's pull request, comment and checks, then wakes the chat. */
async function deliverWake(machines: WorkspaceMachines, wake: ClaimedWake) {
	const { link } = wake;
	const github = await pullRequestWakeGitHub(link);
	const pull = await github.pull();
	if (!pull.open) throw ignore("The pull request is closed.");
	if (
		!pull.sameRepository ||
		String(pull.baseRepositoryId) !== link.repositoryId ||
		pull.headRef !== link.headRef
	)
		throw ignore("The pull request no longer comes from ytimesy's branch.");
	let comment = null;
	if (wake.kind === "ci") {
		if (wake.headSha !== pull.headSha)
			throw ignore("A newer commit replaced the failed one.");
	} else {
		if (!wake.sourceId) throw ignore("The comment is missing.");
		comment = await github.comment(wake.kind, wake.sourceId);
		if (!comment) throw ignore("The comment no longer asks ytimesy.");
		if (!(await github.canWrite(comment.author)))
			throw ignore("Only collaborators with write access can direct ytimesy.");
	}
	const checks =
		wake.kind === "ci"
			? await github.failingChecks(pull.headSha)
			: await failingChecksOrNone(github, pull.headSha);
	if (wake.kind === "ci" && !checks.length)
		throw ignore("No check is failing on the current head.");
	try {
		await consumeUserAction(link.userId, "chat-send");
	} catch (error) {
		if (error instanceof UserActionRateLimited) throw block(error.message);
		throw error;
	}
	const { sessionId } = await wakePullRequestChat(machines, {
		link,
		title: `Fix PR #${pull.number}`,
		text: pullRequestWakePrompt({ kind: wake.kind, pull, checks, comment }),
		messageId: wakeMessageId(`${link.id}:${wake.dedupeKey}`),
	});
	return {
		sessionId,
		reply: comment
			? async () => {
					const app = process.env.APP_URL?.replace(/\/+$/, "");
					await github.reply(
						app
							? `On it: [ytimesy chat](${app}${chatPath(link.projectId, sessionId)}) (visible to the project owner).`
							: "On it: the project owner's ytimesy chat has this request.",
					);
				}
			: null,
	};
}

/**
 * Delivers due GitHub wake-ups (CI failures, comments mentioning @<GITHUB_APP_SLUG>) for pull
 * requests ytimesy opened. Fails closed unless PR repair is enabled.
 */
export async function deliverPullRequestWakes(machines: WorkspaceMachines) {
	if (process.env.YTIMESY_PR_REPAIR_ENABLED !== "1") return;
	for (let index = 0; index < 10; index++) {
		const wake = await claimPullRequestWake();
		if (!wake) return;
		try {
			const delivered = await deliverWake(machines, wake);
			await finishPullRequestWake(wake, {
				status: "delivered",
				sessionId: delivered.sessionId,
			});
			await delivered.reply?.().catch(() => undefined);
		} catch (error) {
			await finishPullRequestWake(
				wake,
				error instanceof PullRequestWakeStopped
					? { status: error.status, reason: error.message }
					: {
							status: "retry",
							reason:
								"Wake delivery failed; check GitHub App permissions, the chat's model connection and the workspace. No fallback was used.",
						},
			);
		}
	}
}
