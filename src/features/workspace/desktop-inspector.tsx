import { ClientOnly } from "@tanstack/react-router";
import { useEffect } from "react";
import {
	desktopInspectorPrompt,
	desktopInspectorShouldStart,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import { DesktopStage } from "./desktop-stage";
import { RetryButton } from "./retry-button";

export function DesktopInspector({
	desktop,
	busy,
	projectId,
	sessionId,
	onStart,
	active = true,
}: {
	desktop: WorkspaceDesktop;
	busy: boolean;
	projectId?: string;
	sessionId?: string;
	onStart: () => void;
	active?: boolean;
}) {
	const shouldStart = desktopInspectorShouldStart({
		tabActive: active,
		projectId,
		sessionId,
		desktop,
		busy,
	});

	useEffect(() => {
		if (!shouldStart) return;
		onStart();
	}, [shouldStart, onStart]);

	if (desktop.status === "running" && projectId && sessionId) {
		return (
			<section className="desktop-inspector" aria-label="Workspace desktop">
				{/* noVNC needs the DOM; the same empty stage stands in until it mounts. */}
				<ClientOnly fallback={<div className="desktop-stage-rfb" />}>
					<DesktopStage
						projectId={projectId}
						sessionId={sessionId}
						password={desktop.viewerPassword}
					/>
				</ClientOnly>
			</section>
		);
	}

	const prompt = desktopInspectorPrompt({ desktop, projectId, sessionId });
	const failed = desktop.status === "failed";
	const starting = desktop.status === "starting" || shouldStart || busy;

	return (
		<section
			className="inspector-empty desktop-inspector-empty"
			data-kind="desktop"
			aria-live="polite"
		>
			<h2>{prompt.title}</h2>
			{failed ? (
				<p className="desktop-inspector-reason" title={prompt.description}>
					{prompt.description}
				</p>
			) : (
				<p>{prompt.description}</p>
			)}
			{/* One fixed-height slot for the button or the status line, so moving
			    between failed and starting shifts nothing below the copy. */}
			<div className="desktop-inspector-action">
				{prompt.actionLabel ? (
					<RetryButton
						label={prompt.actionLabel}
						busy={busy}
						onClick={onStart}
					/>
				) : starting ? (
					<p className="desktop-inspector-status">Starting…</p>
				) : null}
			</div>
		</section>
	);
}
