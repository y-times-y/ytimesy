import { useEffect, useRef, useState } from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import {
	DESKTOP_CONNECT_TIMEOUT_MS,
	DESKTOP_SOCKET_OPEN_TIMEOUT_MS,
	desktopClientViewerUrl,
	desktopDisconnectMessage,
	silentReconnectDelayMs,
} from "#/domain/workspace-desktop";
import { closeOnPageHide, usePageRestores } from "../app/page-lifecycle";
import { RetryButton } from "./retry-button";

type StagePhase =
	| { readonly kind: "connecting" }
	| { readonly kind: "connected" }
	| { readonly kind: "disconnected"; readonly message: string };

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
	const [phase, setPhase] = useState<StagePhase>({ kind: "connecting" });
	const [generation, setGeneration] = useState(0);
	const pageRestores = usePageRestores();
	// Silent reconnects since the screen was last shown (a deploy drops the socket).
	const reconnects = useRef(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a page back from the back/forward cache reconnects.
	useEffect(() => {
		const target = host.current;
		// The generation dependency reconnects with a fresh RFB client.
		if (!target || generation < 0) return;
		let disposed = false;
		let settled = false;
		let connected = false;
		let rfb: { disconnect(): void } | null = null;
		setPhase({ kind: "connecting" });
		const fail = (message: string) => {
			if (disposed || settled) return;
			settled = true;
			setPhase({ kind: "disconnected", message });
			try {
				rfb?.disconnect();
			} catch {
				target.replaceChildren();
			}
			rfb = null;
		};
		// The panel never waits on a silent socket: the relay closes with a
		// reason when it fails, and these cover a socket that never answers.
		const timers: number[] = [];

		void import("@novnc/novnc")
			.then(({ default: RFB }) => {
				if (disposed) return;
				const protocol = window.location.protocol === "https:" ? "wss" : "ws";
				const path = desktopClientViewerUrl({ projectId, sessionId });
				// Our own socket, so its close reason (why the relay gave up)
				// reaches the panel; noVNC only logs it.
				const socket = new WebSocket(
					`${protocol}://${window.location.host}${path}`,
				);
				let closeReason: string | undefined;
				socket.addEventListener("close", (event) => {
					closeReason = event.reason;
				});
				const client = new RFB(
					target,
					socket,
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
				client.addEventListener("connect", () => {
					if (disposed || settled) return;
					connected = true;
					reconnects.current = 0;
					for (const timer of timers) window.clearTimeout(timer);
					setPhase({ kind: "connected" });
				});
				// noVNC removes its canvas on disconnect; without this the panel goes black.
				client.addEventListener("disconnect", (event) => {
					rfb = null;
					// A live screen that dropped without a reason reconnects quietly.
					const delay = silentReconnectDelayMs({
						wasConnected: connected,
						reason: closeReason,
						attempt: reconnects.current,
					});
					if (delay !== null && !disposed && !settled) {
						settled = true;
						reconnects.current += 1;
						setPhase({ kind: "connecting" });
						timers.push(
							window.setTimeout(
								() => setGeneration((value) => value + 1),
								delay,
							),
						);
						return;
					}
					fail(
						desktopDisconnectMessage({
							reason: closeReason,
							connected,
							clean: Boolean(
								(event as CustomEvent<{ clean?: boolean }>).detail?.clean,
							),
						}),
					);
				});
				client.addEventListener("securityfailure", (event) => {
					const reason = (event as CustomEvent<{ reason?: string }>).detail
						?.reason;
					fail(reason || "The desktop refused the connection.");
				});
				// Without a handler noVNC waits for a password forever.
				client.addEventListener("credentialsrequired", () =>
					fail("The desktop asked for a password it wasn't given."),
				);
				rfb = client;
				timers.push(
					window.setTimeout(() => {
						if (socket.readyState === WebSocket.CONNECTING)
							fail("The desktop didn't answer.");
					}, DESKTOP_SOCKET_OPEN_TIMEOUT_MS),
					window.setTimeout(() => {
						if (!connected) fail("The desktop didn't answer.");
					}, DESKTOP_CONNECT_TIMEOUT_MS),
				);
			})
			.catch(() => fail("The desktop viewer failed to load."));

		return closeOnPageHide(() => {
			disposed = true;
			for (const timer of timers) window.clearTimeout(timer);
			try {
				rfb?.disconnect();
			} catch {
				target.replaceChildren();
			}
		});
	}, [projectId, sessionId, password, generation, pageRestores]);

	return (
		<>
			{phase.kind === "disconnected" ? (
				<div
					className="inspector-empty desktop-inspector-empty desktop-stage-overlay"
					data-kind="desktop"
					role="alert"
				>
					<h2>Desktop disconnected</h2>
					<p className="desktop-inspector-line" title={phase.message}>
						{phase.message}
					</p>
					<div className="desktop-inspector-action">
						<RetryButton
							label="Reconnect"
							onClick={() => setGeneration((value) => value + 1)}
						/>
					</div>
				</div>
			) : phase.kind === "connecting" ? (
				<DesktopConnecting />
			) : null}
			<div className="desktop-stage-rfb" ref={host} />
		</>
	);
}

/** Over the stage until the screen shows; also the server-rendered stand-in. */
function DesktopConnecting() {
	return (
		<div
			className="inspector-empty desktop-inspector-empty desktop-stage-overlay"
			data-kind="desktop"
			aria-live="polite"
			aria-busy="true"
		>
			<h2>Connecting to desktop</h2>
			<p className="desktop-inspector-line" />
			<div className="desktop-inspector-action">
				<MatrixDotLoader className="desktop-inspector-spinner" />
			</div>
		</div>
	);
}

/** The stage before noVNC can mount (server render, hydration). */
export function DesktopStagePlaceholder() {
	return (
		<>
			<DesktopConnecting />
			<div className="desktop-stage-rfb" />
		</>
	);
}
