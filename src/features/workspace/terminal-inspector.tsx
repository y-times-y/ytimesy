import { ClientOnly, useHydrated } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { silentReconnectDelayMs } from "#/domain/workspace-desktop";
import {
	TERMINAL_SOCKET_OPEN_TIMEOUT_MS,
	terminalClosedMessage,
	terminalInspectorPrompt,
	terminalInspectorShouldAttach,
} from "#/domain/workspace-terminal";
import {
	cancelInteraction,
	finishInteraction,
	interactionPending,
	startInteraction,
} from "#/features/analytics/web-vitals";
import { closeOnPageHide, usePageRestores } from "../app/page-lifecycle";
import { RetryButton } from "./retry-button";

export function TerminalInspector({
	projectId,
	sessionId,
	active,
}: {
	projectId?: string;
	sessionId?: string;
	active: boolean;
}) {
	// State, not a ref: the attach effect runs again once xterm's frame is
	// in the DOM (it mounts after hydration), instead of finding no frame
	// and never opening the socket.
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [retryGeneration, setRetryGeneration] = useState(0);
	// Silent reconnects since the shell last answered (a deploy drops the socket).
	const reconnects = useRef(0);
	const prompt = terminalInspectorPrompt({ projectId, sessionId });
	const shouldAttach = terminalInspectorShouldAttach({
		tabActive: active,
		projectId,
		sessionId,
	});
	// xterm mounts only after hydration (ClientOnly below); attach then.
	const hydrated = useHydrated();
	const attachAttempt = shouldAttach && hydrated ? retryGeneration + 1 : 0;
	const pageRestores = usePageRestores();

	// biome-ignore lint/correctness/useExhaustiveDependencies: a page back from the back/forward cache reconnects.
	useEffect(() => {
		if (!attachAttempt || !container || !projectId || !sessionId) {
			setConnected(false);
			return;
		}
		// Timed from the open (or a restart) to the shell's first output.
		if (!interactionPending("terminal_ready"))
			startInteraction("terminal_ready");
		let closed = false;
		let dispose: (() => void) | undefined;
		let openTimer: number | undefined;
		let reconnectTimer: number | undefined;
		// The shell answered on this socket, and the relay sent no error.
		let live = false;
		let relayError = false;
		void (async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([
				import("@xterm/xterm"),
				import("@xterm/addon-fit"),
			]);
			await import("@xterm/xterm/css/xterm.css");
			if (closed) return;
			const term = new Terminal({
				convertEol: true,
				cursorBlink: true,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				fontSize: 13,
				theme: {
					background: "#111111",
					foreground: "#e8e8e8",
					cursor: "#eeeeee",
					selectionBackground: "#3d3d3d",
				},
			});
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(container);
			if (closed) {
				term.dispose();
				return;
			}
			fit.fit();
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const url = new URL(`${protocol}//${window.location.host}/api/terminal`);
			url.searchParams.set("projectId", projectId);
			url.searchParams.set("sessionId", sessionId);
			url.searchParams.set("cols", String(term.cols));
			url.searchParams.set("rows", String(term.rows));
			const socket = new WebSocket(url);
			socket.binaryType = "arraybuffer";
			setError(null);
			// A socket that never opens would leave "Starting terminal…" up for good.
			openTimer = window.setTimeout(() => {
				if (closed || socket.readyState !== WebSocket.CONNECTING) return;
				setError("The terminal didn't answer.");
				socket.close();
			}, TERMINAL_SOCKET_OPEN_TIMEOUT_MS);
			socket.addEventListener("open", () => {
				window.clearTimeout(openTimer);
				if (closed) return;
				socket.send(
					JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
				);
			});
			socket.addEventListener("message", (event) => {
				// The socket opens before the machine answers (it may be waking);
				// the shell's first output is what connects the terminal.
				if (!closed && !isTerminalError(event.data)) {
					live = true;
					reconnects.current = 0;
					setConnected(true);
					finishInteraction("terminal_ready");
				}
				if (typeof event.data === "string") {
					try {
						const message = JSON.parse(event.data) as {
							type?: string;
							message?: string;
						};
						if (message.type === "error" && message.message) {
							relayError = true;
							setError(message.message);
							setConnected(false);
						}
					} catch {
						term.write(event.data);
					}
					return;
				}
				term.write(new Uint8Array(event.data as ArrayBuffer));
			});
			socket.addEventListener("close", (event) => {
				if (closed) return;
				// A live shell whose socket dropped without a reason (a deploy,
				// a network blip) re-attaches quietly: the PTY kept running.
				const delay = relayError
					? null
					: silentReconnectDelayMs({
							wasConnected: live,
							reason: event.reason,
							attempt: reconnects.current,
						});
				if (delay !== null) {
					reconnects.current += 1;
					setConnected(false);
					reconnectTimer = window.setTimeout(
						() => setRetryGeneration((value) => value + 1),
						delay,
					);
					return;
				}
				// A clean close carries no error message; without one the panel waited forever.
				setError(
					(current) =>
						current ??
						terminalClosedMessage({
							reason: event.reason,
							wasClean: event.wasClean,
						}),
				);
				setConnected(false);
			});
			socket.addEventListener("error", () => {
				// A live socket's close follows and decides (reconnect or say why).
				if (closed || live) return;
				setError((current) => current ?? "Terminal disconnected.");
				setConnected(false);
			});
			const dataSub = term.onData((data) => {
				if (socket.readyState === WebSocket.OPEN) socket.send(data);
			});
			const observer = new ResizeObserver(() => {
				fit.fit();
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(
						JSON.stringify({
							type: "resize",
							cols: term.cols,
							rows: term.rows,
						}),
					);
				}
			});
			observer.observe(container);
			dispose = () => {
				observer.disconnect();
				dataSub.dispose();
				socket.close();
				term.dispose();
			};
			if (closed) dispose();
		})().catch(() => {
			// xterm's code failed to load (a page older than the last deploy)
			// or failed to start: say so, with Restart, instead of waiting.
			if (closed) return;
			setError("The terminal failed to load.");
			setConnected(false);
		});
		return closeOnPageHide(() => {
			closed = true;
			window.clearTimeout(openTimer);
			window.clearTimeout(reconnectTimer);
			// Closed before the shell answered: no timing for this open.
			cancelInteraction("terminal_ready");
			dispose?.();
			setConnected(false);
		});
	}, [attachAttempt, container, projectId, sessionId, pageRestores]);

	if (!shouldAttach) {
		return (
			<section className="inspector-empty" aria-live="polite">
				<h2>{prompt.title}</h2>
				<p>{prompt.description}</p>
				{error ? (
					<p className="terminal-inspector-error" role="alert">
						{error}
					</p>
				) : null}
			</section>
		);
	}

	return (
		<ClientOnly fallback={<TerminalPlaceholder />}>
			<section className="terminal-inspector" aria-label="Workspace terminal">
				{/* Over the terminal, not above it: the terminal keeps its place and
				    size while it starts, connects or fails. */}
				{error ? (
					<div className="terminal-inspector-notice">
						<p className="terminal-inspector-error" role="alert">
							{error}
						</p>
						<RetryButton
							label="Restart terminal"
							onClick={() => setRetryGeneration((generation) => generation + 1)}
						/>
					</div>
				) : connected ? null : (
					<div className="terminal-inspector-notice">
						<p className="desktop-inspector-status">Starting terminal…</p>
					</div>
				)}
				<div
					ref={setContainer}
					className="terminal-inspector-frame"
					data-connected={connected ? "true" : "false"}
				/>
			</section>
		</ClientOnly>
	);
}

/** The terminal before xterm mounts: the same box, frame and notice overlay. */
export function TerminalPlaceholder() {
	return (
		<section className="terminal-inspector" aria-label="Workspace terminal">
			<div className="terminal-inspector-notice">
				<p className="desktop-inspector-status">Starting terminal…</p>
			</div>
			<div className="terminal-inspector-frame" data-connected="false" />
		</section>
	);
}

function isTerminalError(data: unknown) {
	if (typeof data !== "string") return false;
	try {
		return (JSON.parse(data) as { type?: string }).type === "error";
	} catch {
		return false;
	}
}
