import { agentSessionMachineSlug } from "#/domain/agent-session";
import { WorkspaceId } from "#/domain/ids";
import {
	type SubagentPortDep,
	TurnBoxPortForbidden,
} from "#/domain/turn-box-protocol";
import { subagentToolDefaultDeps } from "../services/subagent-tools";
import type { WorkspaceMachines } from "../services/workspace-machines";
import {
	type AgentSessionRecord,
	agentSessionMetadataForOwner,
	descendantAgentSessionMetadata,
} from "./agent-sessions";
import type { ApiTurn } from "./api-turns";

/**
 * The edge's side of the `subagent` port (docs/turn-runner-boxes.md,
 * "Helpers on a box"): a box's agent tools run their logic on the box and
 * reach the database, the helper chats and the helpers' VMs through here.
 *
 * The box is trusted with its own turn and nothing else. So every user id
 * must be the turn's user, every chat id must be the turn's chat or one of
 * its helpers (descendants), every VM must be the VM of one of those chats,
 * and records (a parent, a sender) are never taken from the box: only their
 * id is, and the record is read here. The edge's own machines are used for
 * VM work; none are taken from the box.
 */
export type TurnBoxSubagentDeps = {
	readonly machines?: () => WorkspaceMachines;
	/** Test hook: the deps the box's calls end in (default: the product's). */
	readonly run?: typeof subagentToolDefaultDeps;
	/** Test hook: the chat and its helpers (default: read from the database). */
	readonly family?: (
		turn: ApiTurn,
	) => Promise<readonly Omit<AgentSessionRecord, "items">[]>;
};

const text = (value: unknown, op: string, max = 8_192) => {
	if (typeof value !== "string" || !value || value.length > max)
		throw new TurnBoxPortForbidden(op);
	return value;
};
const record = (value: unknown, op: string) => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TurnBoxPortForbidden(op);
	return value as Record<string, unknown>;
};
/** A record crossed as `{ id }` (or a whole record): only its id is read. */
const idOf = (value: unknown, op: string) =>
	text(record(value, op).id, op, 128);

export async function subagentPort(
	turn: ApiTurn,
	dep: SubagentPortDep,
	args: readonly unknown[],
	deps: TurnBoxSubagentDeps = {},
): Promise<unknown> {
	const run = deps.run ?? subagentToolDefaultDeps;
	const user = turn.user_id;
	let family: Promise<readonly Omit<AgentSessionRecord, "items">[]> | undefined;
	/** The turn's chat first, then every helper below it. */
	const loadFamily = () => {
		family ??= (
			deps.family ??
			(async (t: ApiTurn) => {
				const [root, descendants] = await Promise.all([
					agentSessionMetadataForOwner(t.user_id, t.session_id),
					descendantAgentSessionMetadata(t.user_id, t.session_id),
				]);
				if (!root) throw new TurnBoxPortForbidden("session");
				return [root, ...descendants];
			})
		)(turn);
		return family;
	};
	const ownUser = (value: unknown) => {
		if (value !== user) throw new TurnBoxPortForbidden(`${dep}:user`);
		return user;
	};
	const ownChat = async (value: unknown) => {
		const id = text(value, `${dep}:session`, 128);
		const found = (await loadFamily()).find((entry) => entry.id === id);
		if (!found) throw new TurnBoxPortForbidden(`${dep}:session`);
		return found;
	};
	/** A record the tool code reads fields of: reloaded here, with no transcript. */
	const ownRecord = async (value: unknown) =>
		({
			...(await ownChat(idOf(value, dep))),
			items: [],
		}) as AgentSessionRecord;
	const machines = () => {
		if (!deps.machines) throw new TurnBoxPortForbidden(`${dep}:machines`);
		return deps.machines();
	};
	switch (dep) {
		case "ancestors":
			return run.ancestors(ownUser(args[0]), (await ownChat(args[1])).id);
		case "tree":
			return run.tree(ownUser(args[0]), (await ownChat(args[1])).id);
		case "itemsOfKinds": {
			const kinds = args[2];
			if (
				!Array.isArray(kinds) ||
				kinds.length > 16 ||
				!kinds.every((kind) => typeof kind === "string" && kind.length < 64)
			)
				throw new TurnBoxPortForbidden(dep);
			return run.itemsOfKinds(
				ownUser(args[0]),
				(await ownChat(args[1])).id,
				kinds,
			);
		}
		case "openTask": {
			const input = record(args[0], dep);
			ownUser(input.userId);
			const parent = await ownChat(input.parentSessionId);
			if (!parent.projectId || input.projectId !== parent.projectId)
				throw new TurnBoxPortForbidden(`${dep}:project`);
			return run.openTask({
				...(input as Parameters<typeof run.openTask>[0]),
				userId: user,
				projectId: parent.projectId,
				parentSessionId: parent.id,
				// Lead mode fusion's shared writer never runs from a box.
				sharedWriter: false,
			});
		}
		case "saveSpec":
			return run.saveSpec(
				ownUser(args[0]),
				(await ownChat(args[1])).id,
				record(args[2], dep) as never,
			);
		case "fork": {
			const input = record(args[0], dep);
			const chats = await loadFamily();
			const parentVm = text(input.parentVm, `${dep}:vm`, 256);
			if (!chats.some((entry) => entry.providerRef === parentVm))
				throw new TurnBoxPortForbidden(`${dep}:vm`);
			// The fork is named for one of this turn's helpers.
			const slug = text(input.slug, `${dep}:slug`, 256);
			if (
				!chats.some((entry) =>
					slug.startsWith(agentSessionMachineSlug(entry.id)),
				)
			)
				throw new TurnBoxPortForbidden(`${dep}:slug`);
			return run.fork({
				machines: machines(),
				parentVm: WorkspaceId(parentVm),
				slug,
			});
		}
		case "saveProviderRef": {
			const chat = await ownChat(args[0]);
			// A VM id the box learned from this turn's own fork answer: only
			// its shape can be checked here (VM ids are unguessable).
			const ref = text(args[1], `${dep}:vm`, 256);
			if (!/^[A-Za-z0-9_-]{4,128}$/.test(ref))
				throw new TurnBoxPortForbidden(`${dep}:vm`);
			return run.saveProviderRef(chat.id, ref);
		}
		case "mergeFork":
			return run.mergeFork(
				(await ownChat(args[0])).id,
				record(args[1], dep) as never,
			);
		case "start": {
			const scope = record(args[0], dep);
			ownUser(scope.userId);
			const parent = await ownChat(scope.sessionId);
			const task = await ownChat(args[1]);
			if (task.parentSessionId !== parent.id)
				throw new TurnBoxPortForbidden(`${dep}:task`);
			// An omitted argument arrives as null: JSON turns undefined in an array into null.
			const options = args[2] == null ? undefined : record(args[2], dep);
			const reasoning =
				typeof options?.reasoning === "string" ? options.reasoning : undefined;
			return run.start(
				{
					userId: user,
					projectId: parent.projectId,
					sessionId: parent.id,
					harnessId: parent.harness,
					createNew: false,
				} as Parameters<typeof run.start>[0],
				task.id,
				reasoning ? { reasoning } : undefined,
			);
		}
		case "routes":
			return run.routes(ownUser(args[0]));
		case "markFailed":
			return run.markFailed((await ownChat(args[0])).id);
		case "releaseStart": {
			ownUser(args[0]);
			const task = await ownChat(args[2]);
			if (!task.projectId || args[1] !== task.projectId)
				throw new TurnBoxPortForbidden(`${dep}:project`);
			return run.releaseStart(user, task.projectId, task.id);
		}
		case "takeReport":
			return run.takeReport((await ownChat(args[0])).id);
		case "message":
		case "queueAfterTurn": {
			const sender = await ownRecord(args[0]);
			const recipient = await ownChat(args[1]);
			const message = text(args[2], dep, 8_000);
			const requestId = text(args[3], dep, 128);
			return run[dep](sender, recipient.id, message, requestId);
		}
		case "interrupt": {
			const sender = await ownRecord(args[1]);
			const recipient = await ownChat(args[2]);
			return run.interrupt(
				machines(),
				sender,
				recipient.id,
				text(args[3], dep, 8_000),
				text(args[4], dep, 128),
			);
		}
		case "stop": {
			const options = args[1] == null ? {} : record(args[1], dep);
			return run.stop((await ownChat(args[0])).id, {
				now: options.now === true,
			});
		}
		case "usageWindowsOpen":
			return run.usageWindowsOpen(ownUser(args[0]));
		default: {
			const never: never = dep;
			throw new TurnBoxPortForbidden(String(never));
		}
	}
}
