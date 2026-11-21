import { WorkspaceId } from "#/domain/ids";
import { posixShellCommand } from "#/domain/posix-command";
import type { SessionItem } from "#/domain/session-item";
import { recordCloudProjectReport } from "../services/project-knowledge";
import { machinesForAgentSession } from "../services/session-workspace-machines";
import type { TurnGitRuntime } from "../services/turn-publication";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { startAfterResponse } from "./after-response";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
} from "./agent-sessions";
import { releaseHeldAgentTaskEvents } from "./agent-task-events";
import { type ApiTurn, replaceSettledTurnItem } from "./api-turns";

/**
 * Work the Durable Object's turn does inside `runApiTurn` that needs the
 * Freestyle account key or GitHub credentials, done by the EDGE for a box's
 * turn (docs/turn-runner-boxes.md, "Whole turn on a box"). Composition only:
 * the same functions `runApiTurn` calls, over the edge's account machines.
 * There is no separate Durable Object step-end for this in the code today
 * (commit, push and the pull request all run inside `runApiTurn`), so the
 * edge's port handlers and `finalize` are the hand-back point.
 */

/** The git runtime `runApiTurn` builds over a workspace's machines. */
export function gitRuntimeOverMachines(
	machines: WorkspaceMachines,
): TurnGitRuntime {
	return {
		exec: (providerRef, argv, _env, timeout) =>
			machines.exec(WorkspaceId(providerRef), posixShellCommand(argv), timeout),
		writeTextFile: (providerRef, path, contents) =>
			machines.writeTextFile(WorkspaceId(providerRef), path, contents),
		readTextFile: (providerRef, path) =>
			machines.readTextFile(WorkspaceId(providerRef), path),
	};
}

/** The chat as `runApiTurn` sees its owner, with the machine its turn ran on. */
export async function ownerOf(turn: Pick<ApiTurn, "user_id" | "session_id">) {
	const owner = await agentSessionMetadataForOwner(
		turn.user_id,
		turn.session_id,
	);
	// The transcript is not read here: commit and publish take the turn's items.
	return owner ? { ...owner, items: [] as unknown } : null;
}

type Settled = "completed" | "failed" | "cancelled";

/**
 * After a box's turn settled (the edge's `finalize`): the push and pull
 * request of changes the edge committed, then, for a completed turn, the
 * cloud project report, held helper reports and the chat's next queued
 * message. Every step is best effort, as it is at the end of `runApiTurn`
 * (each one there swallows its own failure).
 */
export async function afterBoxTurnSettled(
	turn: ApiTurn,
	input: {
		readonly state: Settled;
		readonly items: readonly SessionItem[];
		readonly publish: boolean;
	},
	deps: { readonly machines: () => WorkspaceMachines },
) {
	const work = async () => {
		const owner = await ownerOf(turn);
		if (!owner) return;
		const run = async (label: string, step: () => Promise<unknown>) => {
			try {
				await step();
			} catch (error) {
				console.warn("A box turn's post-settle step failed.", {
					label,
					message: error instanceof Error ? error.message.slice(0, 200) : "?",
				});
			}
		};
		// The memory clone's token: released (scrubbed from the chat's VM and
		// revoked) however the turn ended; the box's own release came after
		// its lease and was refused.
		await run("memory-release", async () => {
			if (owner.parentSessionId) return;
			const { memoryPort } = await import("./turn-box-memory-port");
			await memoryPort(
				turn,
				{ op: "releaseVm", vm: owner.providerRef ?? null, scrub: true },
				{ machines: deps.machines },
			);
		});
		if (input.publish)
			await run("publish", () =>
				publishCommitted(turn, owner, input.items, deps),
			);
		if (input.state !== "completed") return;
		// The memory save hook (runApiTurn's memory.afterTurn): after finalize
		// the box's own port calls are no longer lease-checked, so it is here.
		await run("memory", async () => {
			if (owner.parentSessionId) return;
			const { harnessVariantForUser } = await import("./dev-eval-users");
			const variant = await harnessVariantForUser(turn.user_id);
			const { memoryPort } = await import("./turn-box-memory-port");
			await memoryPort(
				turn,
				{
					op: "afterTurn",
					wording: variant.memoryWording,
					writer: variant.memoryWriter,
				},
				{ machines: deps.machines },
			);
		});
		await run("report", () =>
			recordCloudProjectReport(owner, turn.id, input.items),
		);
		await run("held", async () => {
			if (owner.parentSessionId) return;
			if (await releaseHeldAgentTaskEvents(owner.id))
				await (await import("../jobs/queue")).enqueueAgentTaskEvent();
		});
		await run("queued", async () => {
			const { startQueuedUserTurn } = await import(
				"../services/queued-user-messages"
			);
			await startQueuedUserTurn(
				machinesForAgentSession(deps.machines(), owner),
				turn.user_id,
				turn.session_id,
			);
		});
	};
	// The response goes out first where the platform allows it.
	if (!startAfterResponse(work)) await work();
}

/** Commits again (an empty commit is skipped) to get this turn's publish, then pushes and opens the pull request. */
async function publishCommitted(
	turn: ApiTurn,
	owner: AgentSessionRecord,
	items: readonly SessionItem[],
	deps: { readonly machines: () => WorkspaceMachines },
) {
	const { commitSessionTurn } = await import("../services/turn-commit");
	const { finishPullRequestHandoff } = await import("../jobs/api-turn");
	const committed = await commitSessionTurn(
		owner,
		items,
		gitRuntimeOverMachines(deps.machines()),
	);
	if (committed?.publish)
		await finishPullRequestHandoff(
			turn,
			committed.publish,
			replaceSettledTurnItem,
		);
}
