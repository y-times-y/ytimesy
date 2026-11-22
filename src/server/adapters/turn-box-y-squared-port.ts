import { incomingAttachments } from "#/domain/message-attachment";
import {
	TurnBoxPortForbidden,
	type YSquaredPortDep,
} from "#/domain/turn-box-protocol";
import type { CrewRow } from "#/domain/y-squared-crew";
import type { WorkspaceMachines } from "../services/workspace-machines";
import {
	type YSquaredToolDeps,
	ySquaredToolDefaultDeps,
} from "../services/y-squared-tools";
import { agentSessionMetadataForOwner } from "./agent-sessions";
import type { ApiTurn } from "./api-turns";
import { projectYMode } from "./y-mode";

/**
 * The edge's side of the `ySquared` port (docs/turn-runner-boxes.md, "The
 * super agent and helpers on a box"): a box runs the super agent's (Y²)
 * tools and reaches the database, the project's crew and the other threads
 * through here.
 *
 * The box is trusted with its own turn and nothing else: the turn's chat
 * must be its project's Y² chat; every user is the turn's user and every
 * project the chat's project; a thread named must be a root chat of that
 * project and not Y² itself; the crew is the chat's project's; a schedule is
 * always for this Y² chat; attachments are read from this chat only. The
 * edge's own machines carry sends and stops.
 */
export type TurnBoxYSquaredDeps = {
	readonly machines?: () => WorkspaceMachines;
	/** Test hooks (default: the product's). */
	readonly run?: YSquaredToolDeps;
	readonly owner?: typeof agentSessionMetadataForOwner;
	readonly yMode?: typeof projectYMode;
};

const text = (value: unknown, op: string, max = 512) => {
	if (typeof value !== "string" || !value || value.length > max)
		throw new TurnBoxPortForbidden(op);
	return value;
};
const record = (value: unknown, op: string) => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TurnBoxPortForbidden(op);
	return value as Record<string, unknown>;
};

export async function ySquaredPort(
	turn: ApiTurn,
	dep: YSquaredPortDep,
	args: readonly unknown[],
	deps: TurnBoxYSquaredDeps = {},
): Promise<unknown> {
	const run = deps.run ?? ySquaredToolDefaultDeps;
	const user = turn.user_id;
	const self = await (deps.owner ?? agentSessionMetadataForOwner)(
		user,
		turn.session_id,
	);
	if (!self?.projectId || self.parentSessionId)
		throw new TurnBoxPortForbidden("y2:session");
	const project = self.projectId;
	const mode = await (deps.yMode ?? projectYMode)(user, project);
	if (!mode?.enabled || mode.ySquaredId !== self.id)
		throw new TurnBoxPortForbidden("y2:not-y2");
	const ownUser = (value: unknown) => {
		if (value !== user) throw new TurnBoxPortForbidden(`y2:${dep}:user`);
		return user;
	};
	const ownProject = (value: unknown) => {
		if (value !== project) throw new TurnBoxPortForbidden(`y2:${dep}:project`);
		return project;
	};
	/** A root thread of the project other than Y²: read here, never taken from the box. */
	const thread = async (value: unknown) => {
		const id = text(value, `y2:${dep}:thread`, 128);
		const chat = id === self.id ? null : await run.metadata(user, id);
		if (
			!chat ||
			chat.projectId !== project ||
			chat.parentSessionId ||
			chat.agentRole
		)
			throw new TurnBoxPortForbidden(`y2:${dep}:thread`);
		return chat;
	};
	const machines = () => {
		if (!deps.machines) throw new TurnBoxPortForbidden(`y2:${dep}:machines`);
		return deps.machines();
	};
	const crew = () => run.crew(project);
	switch (dep) {
		case "list":
			ownUser(args[0]);
			return run.list(user, ownProject(args[1]));
		case "metadata": {
			ownUser(args[0]);
			// The tools check the project themselves; answer only this project's chats.
			const chat = await run.metadata(user, text(args[1], dep, 128));
			return chat && chat.projectId === project ? chat : null;
		}
		case "outcome":
			ownUser(args[0]);
			return run.outcome(user, (await thread(args[1])).id);
		case "canvas":
			ownUser(args[0]);
			return run.canvas(
				user,
				(await thread(args[1])).id,
				text(args[2], dep, 200),
			);
		case "download":
			ownUser(args[0]);
			if (args[1] !== self.id) throw new TurnBoxPortForbidden("y2:download");
			return run.download(user, self.id, text(args[2], dep, 128));
		case "send": {
			const scope = record(args[0], dep);
			ownUser(scope.userId);
			ownProject(scope.projectId);
			const input = record(args[1], dep);
			const target =
				scope.createNew === true ? null : await thread(scope.sessionId);
			const parsed =
				input.attachments === undefined
					? undefined
					: incomingAttachments.safeParse(input.attachments);
			if (parsed && !parsed.success)
				throw new TurnBoxPortForbidden("y2:send:attachments");
			const files = parsed?.data;
			return run.send(
				machines(),
				{
					userId: user,
					projectId: project,
					// A new thread takes Y²'s own harness; an existing one keeps its own.
					harnessId: target ? target.harness : self.harness,
					...(target
						? { sessionId: target.id, createNew: false }
						: { createNew: true }),
				} as never,
				{
					text: text(input.text, "y2:send:text", 100_000),
					modelId: text(input.modelId, "y2:send:model", 256),
					idempotencyKey: text(input.idempotencyKey, "y2:send:key", 256),
					...(files ? { attachments: files } : {}),
					...(input.released === true ? { released: true } : {}),
				} as never,
			);
		}
		case "stop": {
			const scope = record(args[0], dep);
			ownUser(scope.userId);
			ownProject(scope.projectId);
			const target = await thread(scope.sessionId);
			return run.stop(machines(), {
				userId: user,
				projectId: project,
				sessionId: target.id,
				harnessId: target.harness,
				createNew: false,
			} as never);
		}
		case "crewList":
			return (await crew()?.list()) ?? null;
		case "crewThread":
			return (await crew()?.thread(text(args[0], dep, 128))) ?? null;
		case "crewReconcile": {
			const rows = args[0];
			if (!Array.isArray(rows) || rows.length > 500)
				throw new TurnBoxPortForbidden("y2:crewReconcile");
			await crew()?.reconcile(rows as CrewRow[]);
			return null;
		}
		case "crewNoteY2Sent": {
			const id = args[0] == null ? null : (await thread(args[0])).id;
			await crew()?.noteY2Sent?.(id);
			return null;
		}
		case "crewSchedule": {
			const client = crew();
			if (!client?.schedule) return null;
			// Always this Y² chat's own schedule, whatever the box names.
			return client.schedule(args[0], { userId: user, ySquaredId: self.id });
		}
		default: {
			const never: never = dep;
			throw new TurnBoxPortForbidden(String(never));
		}
	}
}
