// The fork step of a scenario with `forkAt`: once the chat settled, fork it
// at that user message through the real recovery path (the menu's "Fork
// conversation"), then check the fork's VM, branch and transcript, the
// source's, a turn run in the fork, and that a checkpoint whose refs are gone
// fails the fork's workspace without leaving a VM copy.
import { agentSessionMachineSlug } from "../../src/domain/agent-session";
import { WorkspaceId } from "../../src/domain/ids";
import { posixShellQuoted } from "../../src/domain/posix-command";
import { conversationPoint } from "../../src/server/adapters/conversation-recovery";
import { database } from "../../src/server/adapters/database";
import { PROJECT_CWD_PATH } from "../../src/server/adapters/freestyle/clone-project";
import {
	conversationForkState,
	recoverConversation,
} from "../../src/server/services/conversation-recovery";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";
import type { RehearsalEdge } from "./edge";
import { type Check, FORK_IN_FORK, FORK_MARKER } from "./scenarios";
import type { RehearsalUser } from "./seed";
import { sendFollowUp } from "./seed";
import type { RehearsalVms } from "./vm";

type Item = {
	id?: string;
	kind: string;
	tool?: string;
	text?: string;
	input?: string;
	output?: string;
};

export async function rehearseFork(input: {
	edge: RehearsalEdge;
	machines: WorkspaceMachines;
	vms: RehearsalVms;
	vm: string;
	user: RehearsalUser;
	sessionId: string;
	forkAt: number;
	/** Messages whose turns never touched the workspace, each with the marker its fork must hold. */
	qaForks?: readonly { at: number; marker: string }[];
	timeoutMs: number;
}): Promise<Check[]> {
	const { edge, machines, vms, vm, user, sessionId } = input;
	const checks: Check[] = [];
	const check = (name: string, ok: boolean, detail?: string) =>
		checks.push({ name, ok, ...(detail && !ok ? { detail } : {}) });
	const clip = (text: unknown) =>
		String(text ?? "")
			.replaceAll(/\s+/g, " ")
			.slice(0, 300);
	const marker = async (target: string) =>
		(await vms.root(target, `docker exec tb cat /app/${FORK_MARKER}`)).stdout;
	const branchOf = async (target: string) =>
		(
			await machines.exec(
				WorkspaceId(target),
				`git -C "$(cat ${PROJECT_CWD_PATH})" branch --show-current`,
				30_000,
			)
		).stdout.trim();
	const sessionRow = (id: string) =>
		edge.invoke(
			async () =>
				(
					await database().query<{
						items: Item[];
						provider_ref: string | null;
						working_branch: string | null;
						selected_branch: string | null;
						parent_session_id: string | null;
						status: string;
					}>(
						"select items,provider_ref,working_branch,selected_branch,parent_session_id,status from agent_session where id=$1",
						[id],
					)
				).rows[0],
		);

	// A fork's chat opens before its VM is copied (a background job); its
	// status is null once the copy is bound.
	const forkCopied = async (id: string) => {
		const deadline = Date.now() + input.timeoutMs;
		for (;;) {
			const state = await edge.invoke(() =>
				conversationForkState(user.userId, user.projectId, id),
			);
			if (state?.state !== "preparing" || Date.now() > deadline) return state;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	};

	const source = await sessionRow(sessionId);
	const messages = (source?.items ?? []).filter(
		(item) => item.kind === "userMessage",
	);
	const message = messages[input.forkAt - 1];
	const point = message?.id
		? await edge.invoke(() =>
				conversationPoint(user.userId, sessionId, message.id as string),
			)
		: null;
	check(
		`message ${input.forkAt} has a code checkpoint`,
		Boolean(point?.code),
		`messages ${messages.length}, point ${clip(JSON.stringify(point?.code ?? null))}`,
	);
	if (!message?.id || !point?.code) return checks;
	const sourceBranch = await branchOf(vm);
	// Copies of this chat's VM only: scenarios run side by side, and another
	// scenario's writer fork can land while this one forks.
	const chatForks = () => vms.forks.filter((fork) => fork.source === vm);
	const forksBefore = chatForks().length;
	let forkId: string | undefined;
	const clicked = Date.now();
	try {
		forkId = (
			await edge.invoke(() =>
				recoverConversation(machines, user.userId, {
					projectId: user.projectId,
					sessionId,
					messageId: message.id as string,
					mode: "fork",
				}),
			)
		).id;
	} catch (error) {
		check("Fork conversation succeeded", false, (error as Error).message);
		return checks;
	}
	const opened = Date.now();
	const copied = await forkCopied(forkId);
	check(
		"Fork conversation succeeded",
		copied === null,
		clip(JSON.stringify(copied)),
	);
	if (copied) return checks;
	console.log(
		`rehearsal: fork at message ${input.forkAt} opened in ${((opened - clicked) / 1000).toFixed(1)}s, VM ready in ${((Date.now() - clicked) / 1000).toFixed(1)}s`,
	);
	const fork = await sessionRow(forkId);
	const copy = chatForks().at(-1);
	check(
		"the fork's VM is a copy of the chat's, made for the fork",
		chatForks().length === forksBefore + 1 &&
			copy?.source === vm &&
			copy.slug === agentSessionMachineSlug(forkId) &&
			fork?.provider_ref === copy.vm &&
			fork.status === "ready",
		clip(JSON.stringify({ copy, fork: fork?.provider_ref })),
	);
	if (!fork?.provider_ref) return checks;
	check(
		"the fork's VM holds the message's code (turn 1's marker)",
		(await marker(fork.provider_ref)) === "fork one\n",
		clip(await marker(fork.provider_ref)),
	);
	check(
		"the chat's VM keeps its later code (turn 2's marker)",
		(await marker(vm)) === "fork two\n",
		clip(await marker(vm)),
	);
	const forkBranch = await branchOf(fork.provider_ref);
	check(
		"the fork works on its own branch, the chat on its own",
		Boolean(fork.working_branch) &&
			forkBranch === fork.working_branch &&
			fork.selected_branch === fork.working_branch &&
			forkBranch !== sourceBranch &&
			(await branchOf(vm)) === sourceBranch,
		clip(JSON.stringify({ forkBranch, sourceBranch, row: fork })),
	);
	check(
		"the fork's transcript ends before the forked message; the chat's is whole",
		fork.parent_session_id === null &&
			!fork.items.some((item) => item.id === message.id) &&
			fork.items.some((item) => item.kind === "userMessage") &&
			(await sessionRow(sessionId))?.items.length === source?.items.length,
		clip(JSON.stringify(fork.items.map((item) => item.kind))),
	);

	// A turn in the fork runs on the fork's VM and sees the message's code.
	const logStart = vms.log.length;
	await edge.web(() =>
		sendFollowUp({ user, sessionId: forkId as string, text: FORK_IN_FORK }),
	);
	let settled = "";
	try {
		await edge.until(
			async () => {
				const turns = await database().query<{ state: string }>(
					"select state from api_turn where session_id=$1",
					[forkId],
				);
				return (
					!edge.isActive(forkId as string) &&
					turns.rows.length > 0 &&
					turns.rows.every((turn) =>
						["completed", "failed", "cancelled"].includes(turn.state),
					)
				);
			},
			input.timeoutMs,
			"the fork's turn to settle",
		);
	} catch (error) {
		settled = (error as Error).message;
	}
	const turn = await edge.invoke(
		async () =>
			(
				await database().query<{ state: string; items: Item[] }>(
					"select state,items from api_turn where session_id=$1 order by created_at desc limit 1",
					[forkId],
				)
			).rows[0],
	);
	const shown = turn?.items.find(
		(item) =>
			item.kind === "dynamicToolCall" &&
			item.tool === "bash" &&
			(item.input ?? "").includes(`cat ${FORK_MARKER}`),
	);
	check(
		"a turn in the fork ran on the fork's VM and read turn 1's marker",
		!settled &&
			turn?.state === "completed" &&
			(shown?.output ?? "").includes("fork one") &&
			// The chat's VM holds turn 2's marker, so this output came from the fork's.
			vms.log.slice(logStart).some((entry) => entry.vm === fork.provider_ref),
		settled || clip(JSON.stringify({ state: turn?.state, shown })),
	);

	// Q&A-only messages: no code point; the fork takes the code the next
	// code turn started from, or the chat's checkout now when none followed.
	// The lean tool surface prepares the workspace (and so takes a code
	// point) on every turn's first step; a turn that never prepared it, as on
	// a surface that prepares on the first tool call, leaves its point
	// without code. The rehearsal drops the Q&A points' code to stand for that.
	for (const qa of input.qaForks ?? []) {
		const asked = messages[qa.at - 1];
		const own = asked?.id
			? await edge.invoke(async () => {
					await database().query(
						"update agent_task_command_receipt set response=response #- '{result,code}' where parent_session_id=$1 and request_id=$2",
						[sessionId, `conversation-point:${asked.id}`],
					);
					return conversationPoint(user.userId, sessionId, asked.id as string);
				})
			: null;
		const started = Date.now();
		const result = await edge
			.invoke(() =>
				recoverConversation(machines, user.userId, {
					projectId: user.projectId,
					sessionId,
					messageId: asked?.id as string,
					mode: "fork",
				}),
			)
			.then(
				async ({ id }) => {
					const copied = await forkCopied(id);
					if (copied) return { error: JSON.stringify(copied) };
					const row = await sessionRow(id);
					return row?.provider_ref
						? { marker: await marker(row.provider_ref) }
						: { error: "no VM" };
				},
				(error: Error) => ({ error: error.message }),
			);
		console.log(
			`rehearsal: fork at Q&A message ${qa.at} ready in ${((Date.now() - started) / 1000).toFixed(1)}s`,
		);
		check(
			`a fork at Q&A message ${qa.at} (no code point) holds the code as it was then (${qa.marker.trim()})`,
			Boolean(own) &&
				!own?.code &&
				"marker" in result &&
				result.marker === qa.marker,
			clip(JSON.stringify({ point: own ? Boolean(own.code) : null, result })),
		);
	}

	// A checkpoint whose refs are gone: the fork's chat opens, then shows
	// the refusal in place of a workspace, and no VM copy is left behind.
	const ref = point.code.ref;
	await machines.exec(
		WorkspaceId(vm),
		`git -C ${posixShellQuoted(point.code.cwd)} update-ref -d ${posixShellQuoted(ref)}`,
		30_000,
	);
	const forksNow = chatForks().length;
	const refused = await edge
		.invoke(() =>
			recoverConversation(machines, user.userId, {
				projectId: user.projectId,
				sessionId,
				messageId: message.id as string,
				mode: "fork",
			}),
		)
		.then(
			async ({ id }) => JSON.stringify(await forkCopied(id)),
			(error: Error) => error.message,
		);
	check(
		"a checkpoint whose refs are gone fails the fork's workspace, copying no VM",
		/checkpoint is gone/.test(refused) && chatForks().length === forksNow,
		clip(refused),
	);
	return checks;
}
