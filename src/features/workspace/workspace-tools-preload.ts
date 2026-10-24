/**
 * Loads the code the Files, Terminal and Desktop views run (the editor,
 * xterm, noVNC) ahead of their first open. Each view imports the same
 * modules, so opening one later downloads nothing.
 */
export function preloadWorkspaceTools() {
	void Promise.all([
		import("./source-editor"),
		import("@xterm/xterm"),
		import("@xterm/addon-fit"),
		import("@xterm/xterm/css/xterm.css"),
		import("@novnc/novnc"),
	]).catch(() => undefined);
}
