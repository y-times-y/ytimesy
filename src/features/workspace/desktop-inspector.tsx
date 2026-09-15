import { useLayoutEffect, useRef, useState } from "react";
import {
	SHARED_DESKTOP_HEIGHT,
	SHARED_DESKTOP_WIDTH,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";

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
				<DesktopStage src={desktop.viewerUrl} />
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
					: "Shared desktop";
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
			data-kind="desktop"
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

function DesktopStage({ src }: { src: string }) {
	const viewport = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(1);

	useLayoutEffect(() => {
		const stage = viewport.current;
		if (!stage) return;
		const measureStage = (target: HTMLElement) => {
			const next = Math.min(
				target.clientWidth / SHARED_DESKTOP_WIDTH,
				target.clientHeight / SHARED_DESKTOP_HEIGHT,
			);
			setScale(next > 0 ? next : 1);
		};
		measureStage(stage);
		const observer = new ResizeObserver((entries) => {
			const target = entries[0]?.target;
			if (target instanceof HTMLElement) measureStage(target);
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="desktop-stage" ref={viewport}>
			<div
				className="desktop-stage-frame"
				style={{
					width: SHARED_DESKTOP_WIDTH * scale,
					height: SHARED_DESKTOP_HEIGHT * scale,
				}}
			>
				<iframe
					className="desktop-frame"
					title="Workspace desktop"
					src={src}
					width={SHARED_DESKTOP_WIDTH}
					height={SHARED_DESKTOP_HEIGHT}
					allow="clipboard-read; clipboard-write"
					style={{
						width: SHARED_DESKTOP_WIDTH,
						height: SHARED_DESKTOP_HEIGHT,
						transform: `scale(${scale})`,
					}}
				/>
			</div>
		</div>
	);
}
