import { ClientOnly } from "@tanstack/react-router";
import { memo, useEffect } from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import {
	desktopInspectorPrompt,
	desktopInspectorShouldStart,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import { DesktopStage, DesktopStagePlaceholder } from "./desktop-stage";
import { RetryButton } from "./retry-button";
import "./desktop-inspector.css";

export const DesktopInspector = memo(function DesktopInspector({
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
				{/* noVNC needs the DOM; the same connecting stage stands in until it mounts. */}
				<ClientOnly fallback={<DesktopStagePlaceholder />}>
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
	const starting = prompt.starting || (busy && !prompt.actionLabel);

	return (
		<section
			className="inspector-empty desktop-inspector-empty"
			data-kind="desktop"
			data-starting={starting ? "true" : undefined}
			aria-live="polite"
			aria-busy={starting || undefined}
		>
			<h2>{prompt.title}</h2>
			{/* Always one line tall: the reason, the slow-start hint (fades in by
			    CSS after a delay) or nothing, so no state moves the button slot. */}
			{prompt.description ? (
				<p
					key="description"
					className="desktop-inspector-line"
					title={prompt.description}
				>
					{prompt.description}
				</p>
			) : (
				<p key="hint" className="desktop-inspector-line" data-slow-hint>
					{starting ? prompt.slowHint : null}
				</p>
			)}
			{/* One fixed-height slot for the button or the spinner. */}
			<div className="desktop-inspector-action">
				{prompt.actionLabel ? (
					<RetryButton
						label={prompt.actionLabel}
						busy={busy}
						onClick={onStart}
					/>
				) : starting ? (
					<MatrixDotLoader className="desktop-inspector-spinner" />
				) : null}
			</div>
		</section>
	);
});
