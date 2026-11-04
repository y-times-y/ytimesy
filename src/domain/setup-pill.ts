import { stepDuration } from "./environment-build-progress";
import { firstBuildRunning } from "./project-setup-start";
import type { ChatWaitingOn } from "./sidebar-chats";

/**
 * The project setup's status pill in the chat's top bar, while the project
 * is set up in the background: what it says and how it looks.
 */
export type SetupPill =
	| {
			readonly kind: "running";
			/** "Setting up · Installing dependencies". */
			readonly text: string;
			/** "1m 07s" since the setup's build started; null before it has. */
			readonly elapsed: string | null;
	  }
	| { readonly kind: "needs-you"; readonly text: string }
	| { readonly kind: "ready"; readonly text: "Ready" }
	| { readonly kind: "failed"; readonly text: "Setup failed" };

/** How long "Ready" stays once setup finished. */
export const SETUP_READY_SHOWN_MS = 4_000;

/** The agent's part of setup, after the build: its step label. */
const AGENT_STEP_LABEL = "Checking the project";

type PillWorkspace = {
	readonly status: string;
	readonly build?: { readonly rebuild: boolean } | null;
};

type PillBuild = {
	readonly status: "running" | "ready" | "failed";
	readonly startedAt: string;
};

type PillStep = {
	readonly label: string;
	readonly state: string;
};

type PillSetupChat = {
	readonly id: string;
	readonly turnStatus?: string;
	readonly waitingOn?: ChatWaitingOn | null;
	readonly waitsForSetup?: boolean;
};

/**
 * The pill while setup is active, or failed; null otherwise (never for a
 * rebuild of a working environment). Which chat is open does not change it
 * (setupPillForChat hides it in the setup chat), so opening the setup chat
 * never reads as setup finishing. "Ready" follows an active pill going away.
 */
export function activeSetupPill(input: {
	readonly workspace: PillWorkspace | null | undefined;
	/** The newest build and its steps (the setup card's data); null while unread. */
	readonly build: PillBuild | null;
	readonly steps: readonly PillStep[];
	readonly setupChat: PillSetupChat | null;
	readonly now: number;
}): Exclude<SetupPill, { kind: "ready" }> | null {
	const { workspace, setupChat } = input;
	if (!workspace) return null;
	if (workspace.status === "failed")
		return { kind: "failed", text: "Setup failed" };
	const waitingOn = setupChat?.waitingOn;
	if (waitingOn && waitingOn !== "failed")
		return {
			kind: "needs-you",
			text: waitingOn === "secret" ? "Setup needs a secret" : "Setup needs you",
		};
	const building = firstBuildRunning(workspace);
	const agentWorking =
		setupChat?.turnStatus === "running" || Boolean(setupChat?.waitsForSetup);
	if (!building && !agentWorking) return null;
	const step = building
		? ([...input.steps].reverse().find((item) => item.state === "running")
				?.label ?? "Starting")
		: AGENT_STEP_LABEL;
	return {
		kind: "running",
		text: `Setting up · ${step}`,
		elapsed: input.build
			? stepDuration(
					{ startedAt: input.build.startedAt, completedAt: null },
					input.now,
				)
			: null,
	};
}

/**
 * When "Ready" shows until: an active pill (running, needs you) that goes
 * away means setup finished, so "Ready" shows for SETUP_READY_SHOWN_MS.
 * Anything else keeps what was decided.
 */
export function readyShownUntil(input: {
	readonly previous: SetupPill["kind"] | null;
	readonly next: SetupPill["kind"] | null;
	readonly current: number | null;
	readonly now: number;
}): number | null {
	if (input.next !== null) return null;
	if (input.previous === "running" || input.previous === "needs-you")
		return input.now + SETUP_READY_SHOWN_MS;
	return input.current;
}

/**
 * The pill the open chat draws: the active one, else "Ready" while its
 * moment lasts; none in the setup chat itself.
 */
export function setupPillForChat(input: {
	readonly active: SetupPill | null;
	readonly readyUntil: number | null;
	readonly now: number;
	readonly setupChatId: string | null;
	readonly openChatId: string | undefined;
}): SetupPill | null {
	if (input.setupChatId && input.setupChatId === input.openChatId) return null;
	if (input.active) return input.active;
	return input.readyUntil !== null && input.now < input.readyUntil
		? { kind: "ready", text: "Ready" }
		: null;
}

/** The person's own chat while setup runs: the empty composer says it need not wait. */
export const SETUP_RUNNING_PLACEHOLDER =
	"Describe a task. Setup keeps running in the background.";

/** The composer's placeholder for this pill, or null for the usual one. */
export function setupComposerPlaceholder(pill: SetupPill | null) {
	return pill?.kind === "running" || pill?.kind === "needs-you"
		? SETUP_RUNNING_PLACEHOLDER
		: null;
}
