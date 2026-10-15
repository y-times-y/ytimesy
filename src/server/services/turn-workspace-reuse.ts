import type { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "../adapters/agent-sessions";

/** What a durable step learned preparing its workspace; machines are per invocation. */
export type PreparedTurnWorkspace = {
	session: AgentSessionRecord;
	vm: WorkspaceId;
	cwd: string;
};

type Entry = { at: number; prepared: PreparedTurnWorkspace };

const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 256;
const entries = new Map<string, Entry>();

/**
 * In-memory reuse of a turn's prepared workspace across its durable steps.
 * Preparing binds the VM, checks the checkout, the repository path and the
 * verification baseline: guest and database round trips whose answer does not
 * change between two steps of one turn on the same lease. Memory only: a
 * restarted executor, a resumed step or a failed step prepares from scratch,
 * so it never replaces a durable fact. Guest operations still admit and check
 * the VM's state individually.
 */
export function turnWorkspaceReuse(key: string) {
	const current = () => {
		const entry = entries.get(key);
		if (entry && Date.now() - entry.at > MAX_AGE_MS) {
			entries.delete(key);
			return undefined;
		}
		return entry;
	};
	return {
		read: () => current()?.prepared,
		save: (prepared: PreparedTurnWorkspace) => {
			entries.delete(key);
			entries.set(key, { at: Date.now(), prepared });
			while (entries.size > MAX_ENTRIES)
				entries.delete(entries.keys().next().value as string);
		},
		forget: () => {
			entries.delete(key);
		},
	};
}

export type TurnWorkspaceReuse = ReturnType<typeof turnWorkspaceReuse>;
