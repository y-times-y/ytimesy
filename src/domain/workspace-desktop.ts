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
