import { useEffect, useRef, useState } from "react";
import { desktopClientViewerUrl } from "#/domain/workspace-desktop";
import { closeOnPageHide, usePageRestores } from "../app/page-lifecycle";

type DesktopFrameDisplay = {
	imageRect: (
		x: number,
		y: number,
		width: number,
		height: number,
		mime: string,
		pixels: Uint8Array,
	) => void;
	_renderQPush?: (action: {
		type: "img";
		img: HTMLImageElement;
		x: number;
		y: number;
		width: number;
		height: number;
	}) => void;
};

/**
 * noVNC base64-encodes every JPEG rect on the main thread before decoding it.
 * A blob URL copies the bytes once and lets the browser decode the image.
 */
function showDesktopFramesAsBlobs(display: DesktopFrameDisplay) {
	const push = display._renderQPush?.bind(display);
	if (!push) return;
	const original = display.imageRect.bind(display);
	display.imageRect = (x, y, width, height, mime, pixels) => {
		if (width === 0 || height === 0) return;
		try {
			const copy = new Uint8Array(pixels.byteLength);
			copy.set(pixels);
			const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
			const img = new Image();
			const release = () => {
				setTimeout(() => URL.revokeObjectURL(url), 0);
			};
			img.addEventListener("load", release);
			img.addEventListener("error", () => URL.revokeObjectURL(url));
			img.src = url;
			push({ type: "img", img, x, y, width, height });
		} catch {
			original(x, y, width, height, mime, pixels);
		}
	};
}

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
				// The canvas is positioned by CSS. Scrollbars would change the
				// measured size and make every frame lay out the chat.
				const screen = target.firstElementChild;
				if (screen instanceof HTMLElement) screen.style.overflow = "hidden";
				const display = (client as { _display?: DesktopFrameDisplay })._display;
				if (display) showDesktopFramesAsBlobs(display);
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
					<p>{disconnected}</p>
					<button
						type="button"
						className="desktop-start"
						onClick={() => setGeneration((value) => value + 1)}
					>
						Reconnect
					</button>
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
