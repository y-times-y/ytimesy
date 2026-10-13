import { failureMessage, workspaceLooksGone } from "./failure-message";
import { publicFailureMessage } from "./project-workspace";

export type WorkspaceDesktop =
	| { readonly status: "stopped" }
	| { readonly status: "starting" }
	| {
			readonly status: "running";
			readonly viewerUrl: string | null;
			readonly display: ":0";
			readonly message: string | null;
	  }
	| { readonly status: "failed"; readonly reason: string };

export const START_HARNESS_BEFORE_DESKTOP =
	"Start a harness workspace before opening the desktop.";

export function desktopStartFailureReason(cause: unknown): string {
	const message = failureMessage(cause);
	if (workspaceLooksGone(message)) return START_HARNESS_BEFORE_DESKTOP;
	return publicFailureMessage(
		cause instanceof Error ? cause : new Error(message),
	);
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

export function desktopInspectorPrompt(input: {
	readonly desktop: WorkspaceDesktop;
	readonly projectId?: string;
	readonly sessionId?: string;
}) {
	if (input.desktop.status === "failed") {
		return {
			title: "Desktop failed to start.",
			description: input.desktop.reason,
			actionLabel: "Retry desktop",
		};
	}
	if (input.desktop.status === "starting") {
		return {
			title: "Starting desktop…",
			description:
				"Getting this chat's computer ready. A new or forked chat gets its own copy the first time, which takes a minute or two.",
			actionLabel: null,
		};
	}
	if (!input.projectId) {
		return {
			title: "Shared desktop",
			description: "Select a project to use the desktop.",
			actionLabel: null,
		};
	}
	if (!input.sessionId) {
		return {
			title: "Shared desktop",
			description: "Connect an agent before opening the desktop.",
			actionLabel: null,
		};
	}
	if (input.desktop.status === "running") {
		return {
			title: "Desktop is running.",
			description:
				input.desktop.message ?? "You and the agent share this screen.",
			actionLabel: null,
		};
	}
	return {
		title: "Starting desktop…",
		description:
			"This is the desktop the agent uses for QA. You watch and control the same screen.",
		actionLabel: null,
	};
}

export function desktopClientViewerUrl(input: {
	readonly projectId: string;
	readonly sessionId?: string;
}) {
	const params = new URLSearchParams({ projectId: input.projectId });
	if (input.sessionId) params.set("sessionId", input.sessionId);
	return `/api/desktop?${params}`;
}

export function desktopRemoteOrigin(hostname: string) {
	return `https://${hostname.replace(/\/$/, "")}`;
}

export function desktopHostname(providerRef: string) {
	const slug = providerRef
		.replaceAll(/[^a-zA-Z0-9]/g, "")
		.slice(-12)
		.toLowerCase();
	return `ytimesy-desk-${slug || "local"}.style.dev`;
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
