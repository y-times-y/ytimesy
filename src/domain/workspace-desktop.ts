import { failureMessage, workspaceLooksGone } from "./failure-message";
import { publicFailureMessage } from "./project-workspace";

export type WorkspaceDesktop =
	| { readonly status: "stopped" }
	| { readonly status: "starting" }
	| {
			readonly status: "running";
			readonly viewerUrl: string | null;
			/** The desktop's VNC password, for the owner's viewer only. */
			readonly viewerPassword?: string;
			readonly display: ":0";
			readonly message: string | null;
	  }
	| { readonly status: "failed"; readonly reason: string };

export const START_HARNESS_BEFORE_DESKTOP =
	"Start a harness workspace before opening the desktop.";

export function desktopStartFailureReason(cause: unknown): string {
	const message = failureMessage(cause);
	if (workspaceLooksGone(message)) return START_HARNESS_BEFORE_DESKTOP;
	return publicFailureMessage(new Error(message));
}

export function desktopInspectorShouldStart(input: {
	readonly tabActive: boolean;
	readonly projectId?: string;
	readonly sessionId?: string;
	readonly desktop: WorkspaceDesktop;
	readonly busy: boolean;
}) {
	return Boolean(
		input.tabActive &&
			input.projectId &&
			input.sessionId &&
			!input.busy &&
			input.desktop.status === "stopped",
	);
}

/** What the desktop panel says while the desktop is not on screen: a short
 *  title, at most one line under it, and the button or the starting spinner. */
export type DesktopInspectorPrompt = {
	readonly title: string;
	/** One line (the failure reason, or why there is no desktop yet). */
	readonly description: string | null;
	readonly actionLabel: string | null;
	/** Starting: the spinner shows; `slowHint` fades in if it takes a while. */
	readonly starting: boolean;
	readonly slowHint: string | null;
};

const startingPrompt: DesktopInspectorPrompt = {
	title: "Starting desktop",
	description: null,
	actionLabel: null,
	starting: true,
	slowHint: "First start can take a minute",
};

export function desktopInspectorPrompt(input: {
	readonly desktop: WorkspaceDesktop;
	readonly projectId?: string;
	readonly sessionId?: string;
}): DesktopInspectorPrompt {
	const idle = { actionLabel: null, starting: false, slowHint: null };
	if (input.desktop.status === "failed") {
		return {
			...idle,
			title: "Desktop didn't start",
			description: input.desktop.reason,
			actionLabel: "Try again",
		};
	}
	if (input.desktop.status === "starting") return startingPrompt;
	if (!input.projectId) {
		return {
			...idle,
			title: "Shared desktop",
			description: "Select a project to use the desktop.",
		};
	}
	if (!input.sessionId) {
		return {
			...idle,
			title: "Shared desktop",
			description: "Connect an agent before opening the desktop.",
		};
	}
	if (input.desktop.status === "running") {
		return {
			...idle,
			title: "Desktop is running.",
			description:
				input.desktop.message ?? "You and the agent share this screen.",
		};
	}
	// Stopped with a chat open: the panel starts it straight away.
	return startingPrompt;
}

export function desktopClientViewerUrl(input: {
	readonly projectId: string;
	readonly sessionId?: string;
}) {
	const params = new URLSearchParams({ projectId: input.projectId });
	if (input.sessionId) params.set("sessionId", input.sessionId);
	return `/api/desktop?${params}`;
}

/** How long the desktop socket may take to open before the panel says so. */
export const DESKTOP_SOCKET_OPEN_TIMEOUT_MS = 15_000;
/** How long the viewer may take to show the screen (the relay may wake the machine first). */
export const DESKTOP_CONNECT_TIMEOUT_MS = 120_000;

/**
 * The one line under "Desktop disconnected": the server's close reason when
 * it gave one (its relay closes with why), else what the viewer saw.
 */
export function desktopDisconnectMessage(input: {
	readonly reason?: string;
	readonly connected: boolean;
	readonly clean: boolean;
}) {
	const reason = input.reason?.trim();
	if (reason) return reason;
	if (!input.connected) return "The desktop didn't answer.";
	return input.clean
		? "The desktop connection closed."
		: "The desktop connection was lost.";
}

export function desktopRemoteOrigin(hostname: string) {
	return `https://${hostname.replace(/\/$/, "")}`;
}

export function desktopPortIsListening(output: string) {
	return output.includes("YTIMESY_DESKTOP_UP");
}

/**
 * The agent's first shared-desktop tool call in the running turn: the moment
 * the Desktop tab should catch up with a desktop the agent started itself.
 */
export function agentDesktopActivityInTurn(input: {
	readonly turnStatus: string | undefined;
	readonly items: readonly { kind: string; id: string; tool?: string }[];
}): string | null {
	if (input.turnStatus !== "running") return null;
	let turnStart = 0;
	input.items.forEach((item, index) => {
		if (item.kind === "userMessage") turnStart = index;
	});
	return (
		input.items
			.slice(turnStart)
			.find(
				(item) =>
					item.kind === "dynamicToolCall" && item.tool?.startsWith("browser_"),
			)?.id ?? null
	);
}
