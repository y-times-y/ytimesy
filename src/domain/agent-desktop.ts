import { AGENT_ORCHESTRATION_INSTRUCTIONS } from "./agent-orchestration";
import { agentSecretsDeveloperNote } from "./project-secret";

export const SHARED_DISPLAY = ":0";

export function sharedDesktopDeveloperInstructions(input: {
	readonly cwd: string;
	readonly display?: string;
	readonly secretNames?: readonly string[];
}): string {
	const display = input.display ?? SHARED_DISPLAY;
	return [
		`You are in a ytimesy workspace VM. The project checkout is ${input.cwd}; work there.`,
		`This VM has a shared Linux desktop on DISPLAY=${display}. Connect starts that display so you can computer-use it for QA. The user watches and can control the same screen from the Desktop tab.`,
		`GUI commands must export DISPLAY=${display}. Browser: google-chrome-stable --no-sandbox, google-chrome --no-sandbox, or chromium --no-sandbox. If Chrome is not on PATH yet, wait for it or install google-chrome-stable, then open a window on that display. Pointer/keyboard: xdotool. Screenshots: scrot.`,
		"Do not treat the desktop as a separate machine.",
		visualQaInstructions("shell"),
		agentSecretsDeveloperNote(input.secretNames ?? []).trim(),
		AGENT_ORCHESTRATION_INSTRUCTIONS,
	]
		.filter(Boolean)
		.join(" ");
}

/**
 * When the agent must check its work on screen, and what evidence it reports.
 * "tools" names the browser_* tools; "shell" is for runtimes that drive the
 * display with commands (Claude Code, native Codex).
 */
export function visualQaInstructions(via: "tools" | "shell"): string {
	const how =
		via === "tools"
			? "Start the app with execute_command (a dev server in the background), open it with browser_open on its localhost URL, then browser_screenshot and look at the image; use browser_inspect, browser_click, browser_type and browser_key to check behavior. The first browser tool starts the shared desktop, which the user can watch in the Desktop tab."
			: `Start the app (a dev server in the background), open its localhost URL in Chrome on DISPLAY=${SHARED_DISPLAY}, save a screenshot with scrot and view the image; use xdotool to check behavior.`;
	return `Visual QA: when a change affects what a user sees (pages, components, styles, layout) or the task asks you to check the UI, verify it on the shared desktop before reporting done. ${how} Fix what the screenshot shows is wrong. In the final report, state the URL you checked and what the screenshot showed, or why visual QA was not possible.`;
}
