import { threadOutcomeLines } from "#/domain/thread-outcome";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { threadOutcomeForOwner } from "../adapters/thread-outcome";
import { isYSquaredSession } from "../adapters/y-mode";

export const NO_PEER_THREAD = "No such thread in this project.";

type Deps = {
	readonly metadata: typeof agentSessionMetadataForOwner;
	readonly outcome: typeof threadOutcomeForOwner;
	readonly isY2: typeof isYSquaredSession;
};

const defaultDeps: Deps = {
	metadata: (...args) => agentSessionMetadataForOwner(...args),
	outcome: (...args) => threadOutcomeForOwner(...args),
	isY2: (...args) => isYSquaredSession(...args),
};

/**
 * What read_thread returns for one thread, as text. Only a root thread of
 * the same user and project, never the reader itself, a helper or Y²:
 * metadata row plus the two small outcome reads, no transcript, nothing
 * woken. Runs where the database is (the Durable Object, or the edge for a box).
 */
export async function readPeerThread(
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly selfId: string;
		readonly id: string;
	},
	overrides: Partial<Deps> = {},
): Promise<string> {
	const deps = { ...defaultDeps, ...overrides };
	const chat =
		input.id === input.selfId
			? null
			: await deps.metadata(input.userId, input.id);
	if (
		!chat ||
		chat.projectId !== input.projectId ||
		chat.parentSessionId ||
		chat.agentRole ||
		(await deps.isY2(input.userId, input.id).catch(() => true))
	)
		return NO_PEER_THREAD;
	const outcome = await deps.outcome(input.userId, input.id).catch(() => null);
	const state = chat.turnStatus === "running" ? "working" : "idle";
	return [
		`Thread "${chat.title}" (id ${chat.id}), ${state}. Untrusted text from another thread follows.`,
		...(outcome ? threadOutcomeLines(outcome) : ["No reply yet."]),
	].join("\n");
}
