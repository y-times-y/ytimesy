import { failureMessage, workspaceLooksGone } from "./failure-message";

export const SHARED_DESKTOP_WIDTH = 1440;
export const SHARED_DESKTOP_HEIGHT = 900;

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
	return workspaceLooksGone(message) ? START_HARNESS_BEFORE_DESKTOP : message;
}

export function desktopFailedBecauseWorkspaceGone(cause: unknown): boolean {
	return workspaceLooksGone(failureMessage(cause));
}

export function desktopViewerUrl(desktop: WorkspaceDesktop): string | null {
	return desktop.status === "running" ? desktop.viewerUrl : null;
}

export function desktopCanBeControlled(desktop: WorkspaceDesktop): boolean {
	return desktop.status === "running" && Boolean(desktop.viewerUrl);
}

export function desktopHostname(providerRef: string) {
	const slug = providerRef
		.replaceAll(/[^a-zA-Z0-9]/g, "")
		.slice(-12)
		.toLowerCase();
	return `ytimesy-desk-${slug || "local"}.style.dev`;
}

export function desktopEmbedUrl(origin: string): string {
	return `${origin.replace(/\/$/, "")}/vnc.html?autoconnect=1&resize=off&reconnect=1`;
}

export function desktopViewerUrlForMachine(providerRef: string) {
	return desktopEmbedUrl(`https://${desktopHostname(providerRef)}`);
}

export function desktopPortIsListening(output: string) {
	return output.includes("YTIMESY_DESKTOP_UP");
}
