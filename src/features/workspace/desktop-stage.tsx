import { useEffect, useRef, useState } from "react";
import { desktopClientViewerUrl } from "#/domain/workspace-desktop";
import { closeOnPageHide, usePageRestores } from "../app/page-lifecycle";
import { RetryButton } from "./retry-button";

export function DesktopStage({
	projectId,
	sessionId,
	password,
}: {
	projectId: string;
	sessionId: string;
	/** The desktop's VNC password; its x11vnc asks every client for it. */
	password?: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const [disconnected, setDisconnected] = useState<string | null>(null);
	const [generation, setGeneration] = useState(0);
	const pageRestores = usePageRestores();

	// biome-ignore lint/correctness/useExhaustiveDependencies: a page back from the back/forward cache reconnects.
	useEffect(() => {
		const target = host.current;
		// The generation dependency reconnects with a fresh RFB client.
		if (!target || generation < 0) return;
		let disposed = false;
		let rfb: { disconnect(): void } | null = null;
		setDisconnected(null);

		void import("@novnc/novnc")
			.then(({ default: RFB }) => {
				if (disposed) return;
				const protocol = window.location.protocol === "https:" ? "wss" : "ws";
				const path = desktopClientViewerUrl({ projectId, sessionId });
				const client = new RFB(
					target,
					`${protocol}://${window.location.host}${path}`,
					password ? { credentials: { password } } : undefined,
				);
				client.scaleViewport = true;
				client.clipViewport = true;
				client.resizeSession = false;
				client.showDotCursor = true;
				client.background = "#111111";
				// noVNC removes its canvas on disconnect; without this the panel goes black.
				client.addEventListener("disconnect", (event) => {
					if (disposed) return;
					rfb = null;
					setDisconnected(
						(event as CustomEvent<{ clean?: boolean }>).detail?.clean
							? "The desktop connection closed."
							: "The desktop connection was lost.",
					);
				});
				client.addEventListener("securityfailure", (event) => {
					if (disposed) return;
					const reason = (event as CustomEvent<{ reason?: string }>).detail
						?.reason;
					setDisconnected(reason || "The desktop refused the connection.");
				});
				rfb = client;
			})
			.catch(() => {
				if (!disposed) setDisconnected("The desktop viewer failed to load.");
			});

		return closeOnPageHide(() => {
			disposed = true;
			try {
				rfb?.disconnect();
			} catch {
				target.replaceChildren();
			}
		});
	}, [projectId, sessionId, password, generation, pageRestores]);

	return (
		<>
			{disconnected ? (
				<div
					className="inspector-empty desktop-inspector-empty"
					data-kind="desktop"
					role="alert"
				>
					<h2>Desktop disconnected</h2>
					<p className="desktop-inspector-line" title={disconnected}>
						{disconnected}
					</p>
					<div className="desktop-inspector-action">
						<RetryButton
							label="Reconnect"
							onClick={() => setGeneration((value) => value + 1)}
						/>
					</div>
				</div>
			) : null}
			<div
				className="desktop-stage-rfb"
				hidden={Boolean(disconnected)}
				ref={host}
			/>
		</>
	);
}
