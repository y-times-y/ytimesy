export const SHARED_DISPLAY = ":0";

export function sharedDesktopDeveloperInstructions(input: {
	readonly cwd: string;
	readonly display?: string;
}): string {
	const display = input.display ?? SHARED_DISPLAY;
	return [
		`You are in a ytimesy workspace VM. The project checkout is ${input.cwd}; work there.`,
		`This VM has a shared Linux desktop on DISPLAY=${display}. The user watches and can control that same screen from the Desktop tab.`,
		"Use that display for QA and computer-use the way a local desktop session works: a Chrome window is already open there. Click, type, and screenshot on that same screen. Do not treat the desktop as a separate machine.",
		`GUI commands must export DISPLAY=${display}. Browser: google-chrome-stable --no-sandbox, google-chrome --no-sandbox, or chromium --no-sandbox. Pointer/keyboard: xdotool. Screenshots: scrot.`,
	].join(" ");
}
