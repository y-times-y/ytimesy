import { CODE_MODE_TOOL } from "./code-mode";
import { failureMessage, workspaceLooksGone } from "./failure-message";
import { leanToolNames } from "./harness-model-profile";
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

export function desktopPortIsListening(output: string) {
	return output.includes("YTIMESY_DESKTOP_UP");
}

const SHELL_TOOLS = new Set<string>([
	...leanToolNames(["command"]),
	"execute_command",
	"bash",
	"shell",
]);
const EDIT_TOOLS = new Set<string>([
	...leanToolNames(["write", "edit"]),
	"apply_patches",
	"create_file",
	"replace_text",
	"rename_symbol",
	"rename_file",
]);
const IMAGE_TOOLS = new Set<string>(leanToolNames(["image"]));
/** Work that means the desktop went idle, unless that call is itself desktop use. */
const STREAK_BREAK_TOOLS = new Set<string>([
	...SHELL_TOOLS,
	...EDIT_TOOLS,
	CODE_MODE_TOOL,
]);
const DESKTOP_COMMAND = /\bytimesy-browser\b|\bxdotool\b|\bscrot\b|DISPLAY=:0/;
const DESKTOP_SCREENSHOT = /ytimesy-(?:api-)?screenshot/;
const COMPUTER_TOOL = /^computer(?:$|[_-])/;

export type DesktopActivityItem = {
	readonly kind: string;
	readonly id: string;
	readonly tool?: string;
	readonly command?: string;
	readonly input?: string;
};

function mentionsDesktop(text: string) {
	return (
		text.includes("ytimesy-browser") ||
		text.includes("xdotool") ||
		text.includes("scrot") ||
		text.includes("DISPLAY=:0") ||
		text.includes("ytimesy-screenshot") ||
		text.includes("ytimesy-api-screenshot")
	);
}

/** The shell or program text inside a tool call's JSON input. */
function commandText(input: string) {
	try {
		const parsed = JSON.parse(input) as {
			command?: unknown;
			cmd?: unknown;
			code?: unknown;
		};
		const command = parsed?.command ?? parsed?.cmd ?? parsed?.code;
		return typeof command === "string" ? command : input;
	} catch {
		return input;
	}
}

function isDesktopCommand(text: string) {
	return mentionsDesktop(text) && DESKTOP_COMMAND.test(text);
}

function isDesktopUse(item: DesktopActivityItem) {
	if (item.kind === "commandExecution")
		return Boolean(item.command && isDesktopCommand(item.command));
	if (item.kind !== "dynamicToolCall" || !item.tool) return false;
	if (item.tool.startsWith("browser_") || COMPUTER_TOOL.test(item.tool))
		return true;
	if (!item.input || !mentionsDesktop(item.input)) return false;
	if (SHELL_TOOLS.has(item.tool) || item.tool === CODE_MODE_TOOL)
		return isDesktopCommand(commandText(item.input));
	if (IMAGE_TOOLS.has(item.tool))
		return DESKTOP_SCREENSHOT.test(item.input) || isDesktopCommand(item.input);
	return false;
}

/** An edit or a non-desktop command: the desktop is idle after this. */
function breaksDesktopStreak(item: DesktopActivityItem) {
	if (item.kind === "fileChange" || item.kind === "commandExecution")
		return true;
	return (
		item.kind === "dynamicToolCall" &&
		Boolean(item.tool && STREAK_BREAK_TOOLS.has(item.tool))
	);
}

/**
 * The desktop-use streak still in progress, or null when the desktop is idle.
 * Screenshots and frames keep the id of the call that started the streak.
 * The streak ends when the turn stops, or when the agent edits or runs a
 * command that is not the desktop; the next desktop call is a new streak.
 */
export function desktopUseStreakId(input: {
	readonly turnStatus: string | undefined;
	readonly items: readonly DesktopActivityItem[];
}): string | null {
	if (input.turnStatus !== "running") return null;
	let turnStart = 0;
	input.items.forEach((item, index) => {
		if (item.kind === "userMessage") turnStart = index;
	});
	let streak: string | null = null;
	for (const item of input.items.slice(turnStart)) {
		if (isDesktopUse(item)) {
			if (streak === null) streak = item.id;
			continue;
		}
		if (breaksDesktopStreak(item)) streak = null;
	}
	return streak;
}

/**
 * Open the desktop sidebar for a streak the user has not closed.
 * A dismissed streak stays closed through its later frames; a different
 * streak id (the desktop went idle, then started again) opens it.
 */
export function desktopSidebarShouldOpen(input: {
	readonly streakId: string | null;
	readonly dismissedStreakId: string | null;
}): boolean {
	return input.streakId !== null && input.streakId !== input.dismissedStreakId;
}
