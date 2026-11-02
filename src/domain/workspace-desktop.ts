import { machineFailureMessage } from "./api-turn-failure";
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
	// The chat's machine failed to start: worded as the chat words it, never
	// the provider's raw text.
	const machine = machineFailureMessage(cause);
	if (machine) return machine;
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

/** Backoff of the silent reconnects after a live socket drops (about 15 s in all). */
export const SILENT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * When a desktop or terminal socket that was live drops without a reason
 * from our relay (a deploy swapping the Worker, a network blip), the panel
 * reconnects on its own after this delay; null once the reconnects are
 * spent, or when the relay said why it closed (that is shown instead).
 */
export function silentReconnectDelayMs(input: {
	readonly wasConnected: boolean;
	readonly reason?: string;
	readonly attempt: number;
}): number | null {
	if (!input.wasConnected || input.reason?.trim()) return null;
	return SILENT_RECONNECT_DELAYS_MS[input.attempt] ?? null;
}
