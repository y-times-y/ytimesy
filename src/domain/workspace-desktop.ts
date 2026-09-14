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

export function desktopViewerUrlForMachine(providerRef: string) {
	return `https://${desktopHostname(providerRef)}/vnc.html?autoconnect=1&resize=scale&reconnect=1`;
}

export function desktopPortIsListening(output: string) {
	return output.includes("YTIMESY_DESKTOP_UP");
}
