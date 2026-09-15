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
					: "Starting the shared desktop…";
	const description =
		desktop.status === "failed"
			? desktop.reason
			: desktop.status === "running"
				? (desktop.message ??
					"The agent computer-uses display :0. Browser access is not mapped yet.")
				: "This is the Linux desktop the agent uses for QA. You watch and control the same screen.";

	return (
		<section
			className="inspector-empty desktop-inspector-empty"
			aria-live="polite"
		>
			<h2>{title}</h2>
			<p>{description}</p>
			{desktop.status === "starting" || busy ? (
				<p className="desktop-inspector-status">Starting…</p>
			) : (
				<button type="button" className="desktop-start" onClick={onStart}>
					{desktop.status === "failed" ? "Retry desktop" : "Start desktop"}
				</button>
			)}
		</section>
	);
}
