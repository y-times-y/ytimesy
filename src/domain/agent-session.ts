import type { AgentProviderId } from "./agent-provider";
import { isWorkspaceAtCapacity, workspaceLooksGone } from "./failure-message";
import {
	type SessionTurnStatus,
	sessionItemsFromUnknown,
} from "./session-item";
import { type ChatWaitingOn, chatWaitingOn } from "./sidebar-chats";

export function projectEnvironmentSnapshotSlug(workspaceId: string) {
	return `ytimesy-pe-${compactId(workspaceId)}`;
}

/**
 * A chat's VM slug: 'ytimesy-ag-<id16>' for its first machine, and
 * 'ytimesy-ag-<id16>-r<n>' (n >= 2) for the machine that replaced an
 * unstartable one (see nextAgentSessionMachineSlug). Slugs are matched in SQL
 * by sessionSlugMatch (freestyle/slug-sql.ts); keep both in step.
 */
export function agentSessionMachineSlug(sessionId: string, generation = 1) {
	const base = `ytimesy-ag-${compactId(sessionId)}`;
	return generation > 1 ? `${base}-r${generation}` : base;
}

/** The generation a slug names for this chat (1 for the original), or null for another chat's or a foreign slug. */
export function agentSessionSlugGeneration(sessionId: string, slug: string) {
	const base = agentSessionMachineSlug(sessionId);
	if (slug === base) return 1;
	const match = /^-r([2-9]|[1-9][0-9]+)$/.exec(slug.slice(base.length));
	return slug.startsWith(base) && match ? Number(match[1]) : null;
}

/**
 * The slug for the machine replacing the one named `currentSlug`: one
 * generation on, so a replacement never adopts the VM it replaces. An
 * unknown current slug counts as the original machine.
 */
export function nextAgentSessionMachineSlug(
	sessionId: string,
	currentSlug: string | null | undefined,
) {
	const generation = currentSlug
		? (agentSessionSlugGeneration(sessionId, currentSlug) ?? 1)
		: 1;
	return agentSessionMachineSlug(sessionId, generation + 1);
}

export type SessionMachinePlan =
	| { readonly kind: "resume"; readonly providerRef: string }
	| { readonly kind: "copy-snapshot"; readonly snapshotId: string }
	| { readonly kind: "needs-snapshot"; readonly providerRef: string }
	| { readonly kind: "boot-fresh" };

/**
 * A project environment is the prepared template. Agents never edit it.
 * New sessions copy from its snapshot onto their own VM. A missing snapshot
 * is sealed from the unused template, then copied — never attached. Before
 * the project's first template exists a chat never waits for it: its machine
 * boots from the shared tools image, and the chat's turn clones the project
 * and installs it in the background (fresh-machine-setup.ts).
 */
export function sessionMachinePlan(input: {
	readonly sessionProviderRef: string | null;
	readonly templateSnapshotId: string | null;
	readonly templateProviderRef: string | null;
}): SessionMachinePlan {
	if (input.sessionProviderRef)
		return { kind: "resume", providerRef: input.sessionProviderRef };
	if (input.templateSnapshotId)
		return { kind: "copy-snapshot", snapshotId: input.templateSnapshotId };
	if (input.templateProviderRef)
		return { kind: "needs-snapshot", providerRef: input.templateProviderRef };
	return { kind: "boot-fresh" };
}

export function shouldResealProjectSnapshotAfterCopyFailure(message: string) {
	if (isWorkspaceAtCapacity(message)) return false;
	return (
		workspaceLooksGone(message) ||
		/snapshot/i.test(message) ||
		/expired|auto.?delete/i.test(message)
	);
}

/**
 * Freestyle can keep reporting the VM cap for a short time after Delete
 * chat destroys a machine. Retry the copy; do not reseal the template.
 */
const WORKSPACE_COPY_CAPACITY_RETRY_DELAYS_MS = [4_000, 8_000, 16_000] as const;

export function workspaceCopyCapacityRetryDelaysMs(message: string) {
	return isWorkspaceAtCapacity(message)
		? WORKSPACE_COPY_CAPACITY_RETRY_DELAYS_MS
		: [];
}

/** Marks the project's Y² chat and lists it first; the others keep their order. */
export function pinnedYSquared<Chat extends { readonly id: string }>(
	chats: readonly Chat[],
	ySquaredId: string | null | undefined,
): readonly (Chat & { readonly role?: "y2"; readonly unused?: boolean })[] {
	if (!ySquaredId) return chats;
	const ySquared = chats.find((chat) => chat.id === ySquaredId);
	if (!ySquared) return chats;
	return [
		{ ...ySquared, role: "y2" as const, unused: false },
		...chats.filter((chat) => chat.id !== ySquaredId),
	];
}

export function chatsFromAgentSessions(
	sessions: readonly {
		readonly id: string;
		readonly title: string;
		readonly parentSessionId?: string | null;
		readonly turnStatus?: SessionTurnStatus;
		readonly listedModelId?: string | null;
		readonly harness?: AgentProviderId | null;
		readonly updatedAt?: string | null;
		readonly workspaceId?: string | null;
		readonly workingBranch?: string | null;
		readonly taskBranch?: string | null;
		readonly selectedBranch?: string | null;
		/** What the chat waits on from the user, as stored (agent_session.waiting_on). */
		readonly waitingOn?: ChatWaitingOn | null;
		/** The chat's history, when `waitingOn` is not given: only what it waits on is listed. */
		readonly items?: unknown;
		/** When Main's or a helper's active turn started, if one runs. */
		readonly workingSince?: string | null;
		/** Opened but never used: the sidebar lists it only while it is open. */
		readonly unused?: boolean;
		/** Holds a message until the project's environment is ready. */
		readonly waitsForSetup?: boolean;
	}[],
) {
	return sessions
		.filter((session) => !session.parentSessionId)
		.map((session) => ({
			id: session.id,
			title: session.title,
			turnStatus: session.turnStatus ?? "idle",
			listedModelId: session.listedModelId ?? null,
			harnessId: session.harness ?? null,
			updatedAt: session.updatedAt ?? null,
			workspaceId: session.workspaceId ?? null,
			...(session.workingSince ? { workingSince: session.workingSince } : {}),
			...(session.unused ? { unused: true as const } : {}),
			...(session.waitsForSetup ? { waitsForSetup: true as const } : {}),
			...(session.waitingOn !== undefined
				? { waitingOn: session.waitingOn }
				: session.items === undefined
					? {}
					: {
							waitingOn: chatWaitingOn(
								sessionItemsFromUnknown(session.items),
								session.turnStatus ?? "idle",
							),
						}),
			...(session.workingBranch || session.taskBranch
				? { workingBranch: session.workingBranch || session.taskBranch }
				: {}),
			...(session.selectedBranch || session.workingBranch || session.taskBranch
				? {
						selectedBranch:
							session.selectedBranch ||
							session.workingBranch ||
							session.taskBranch,
					}
				: {}),
		}));
}

/** Prepared snapshots from the native-runtime era can still hold these; copies remove them. */
const COPIED_SESSION_SCRATCH_PATHS = [
	"/tmp/ytimesy-opencode-status.json",
	"/tmp/ytimesy-claude-auth-status.json",
	"/tmp/ytimesy-auth-status.json",
	"/tmp/ytimesy-opencode-serve.pid",
	"/tmp/ytimesy-opencode-serve.log",
	"/tmp/ytimesy-opencode-http-body",
	"/tmp/ytimesy-opencode-auth.json",
	"/tmp/ytimesy-opencode-auth-result.txt",
	"/tmp/ytimesy-task-request.json",
	"/tmp/ytimesy-task-result.json",
	"/tmp/ytimesy-side-request.json",
	"/tmp/ytimesy-side-result.json",
	"/tmp/ytimesy-project-context.md",
] as const;

const COPIED_SESSION_DB_FILES = [
	"/home/ubuntu/.local/share/opencode/opencode.db",
	"/home/ubuntu/.local/share/opencode/opencode.db-wal",
	"/home/ubuntu/.local/share/opencode/opencode.db-shm",
	"/root/.local/share/opencode/opencode.db",
	"/root/.local/share/opencode/opencode.db-wal",
	"/root/.local/share/opencode/opencode.db-shm",
] as const;

const COPIED_SESSION_SCRATCH_TREES = [
	"/home/ubuntu/.local/share/opencode/log",
	"/home/ubuntu/.local/state/opencode",
	"/home/ubuntu/.codex/sessions",
	"/root/.local/share/opencode/log",
	"/root/.local/state/opencode",
	"/root/.codex/sessions",
] as const;

export function copiedSessionScratchResetCommand() {
	return `rm -rf ${[
		...COPIED_SESSION_SCRATCH_PATHS,
		...COPIED_SESSION_DB_FILES,
		...COPIED_SESSION_SCRATCH_TREES,
	].join(" ")}`;
}

export function copiedSessionScratchResetCommands() {
	return [copiedSessionScratchResetCommand()] as const;
}

export function sessionMachineRefsToDestroy(input: {
	readonly sessionProviderRef: string | null;
	readonly childProviderRefs?: readonly (string | null)[];
	readonly templateProviderRef: string | null;
}): string[] {
	const refs = [
		input.sessionProviderRef,
		...(input.childProviderRefs ?? []),
	].filter((ref): ref is string => Boolean(ref));
	return [...new Set(refs)].filter((ref) => ref !== input.templateProviderRef);
}

export function copiedAgentMachineRef(input: {
	readonly sessionProviderRef: string | null;
	readonly templateProviderRef: string | null;
}) {
	return (
		sessionMachineRefsToDestroy({
			sessionProviderRef: input.sessionProviderRef,
			templateProviderRef: input.templateProviderRef,
		})[0] ?? null
	);
}

function compactId(value: string) {
	return value.replaceAll("-", "").slice(0, 16);
}
