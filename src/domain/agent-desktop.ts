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
		agentSecretsDeveloperNote(input.secretNames ?? []).trim(),
		AGENT_ORCHESTRATION_INSTRUCTIONS,
	]
		.filter(Boolean)
		.join(" ");
}
