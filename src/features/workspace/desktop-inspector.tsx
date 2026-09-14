import type { WorkspaceDesktop } from "#/domain/workspace-desktop";

export function DesktopInspector({
	desktop,
	busy,
	onStart,
}: {
	desktop: WorkspaceDesktop;
	busy: boolean;
	onStart: () => void;
}) {
	if (desktop.status === "running" && desktop.viewerUrl) {
		return (
			<section className="desktop-inspector" aria-label="Workspace desktop">
				<p className="desktop-inspector-copy">
					{desktop.message ?? "You and the agent share this desktop."}
				</p>
				<iframe
					className="desktop-frame"
					title="Workspace desktop"
					src={desktop.viewerUrl}
					allow="clipboard-read; clipboard-write"
				/>
			</section>
		);
	}

	const title =
		desktop.status === "failed"
			? "Desktop failed to start."
			: desktop.status === "starting"
				? "Starting desktop…"
				: desktop.status === "running"
					? "Desktop is running on the VM."
					: "No desktop yet.";
	const description =
		desktop.status === "failed"
			? desktop.reason
			: desktop.status === "running"
				? (desktop.message ?? "The agent can use display :0. Browser access is not mapped yet.")
				: "Start a shared Linux desktop the agent can computer-use. You can watch and control it here.";

	return (
		<section className="inspector-empty desktop-inspector-empty" aria-live="polite">
			<h2>{title}</h2>
			<p>{description}</p>
			<button
				type="button"
				className="desktop-start"
				onClick={onStart}
				disabled={busy || desktop.status === "starting"}
			>
				{desktop.status === "starting" || busy ? "Starting…" : "Start desktop"}
			</button>
		</section>
	);
}
