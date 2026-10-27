import { useEffect, useRef, useState } from "react";
import {
	terminalClosedMessage,
	terminalInspectorPrompt,
	terminalInspectorShouldAttach,
} from "#/domain/workspace-terminal";

export function TerminalInspector({
	projectId,
	sessionId,
	active,
}: {
	projectId?: string;
	sessionId?: string;
	active: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);
	const [retryGeneration, setRetryGeneration] = useState(0);
	const prompt = terminalInspectorPrompt({ projectId, sessionId });
	const shouldAttach = terminalInspectorShouldAttach({
		tabActive: active,
		projectId,
		sessionId,
	});
	const attachAttempt = shouldAttach ? retryGeneration + 1 : 0;

	useEffect(() => {
		if (!attachAttempt || !containerRef.current || !projectId || !sessionId) {
			setConnected(false);
			return;
		}
		const container = containerRef.current;
		let closed = false;
		let dispose: (() => void) | undefined;
		void (async () => {
			const [{ Terminal }, { FitAddon }] = await Promise.all([
				import("@xterm/xterm"),
				import("@xterm/addon-fit"),
			]);
			await import("@xterm/xterm/css/xterm.css");
			if (closed || containerRef.current !== container) return;
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
			socket.addEventListener("open", () => {
				if (closed) return;
				socket.send(
					JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
				);
			});
			socket.addEventListener("message", (event) => {
				// The socket opens before the machine answers (it may be waking);
				// the shell's first output is what connects the terminal.
				if (!closed && !isTerminalError(event.data)) setConnected(true);
				if (typeof event.data === "string") {
					try {
						const message = JSON.parse(event.data) as {
							type?: string;
							message?: string;
						};
						if (message.type === "error" && message.message) {
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
				if (closed) return;
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
		})();
		return () => {
			closed = true;
			dispose?.();
			setConnected(false);
		};
	}, [attachAttempt, projectId, sessionId]);

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
		<section className="terminal-inspector" aria-label="Workspace terminal">
			{/* Over the terminal, not above it: the terminal keeps its place and
			    size while it starts, connects or fails. */}
			{error ? (
				<div className="terminal-inspector-notice">
					<p className="terminal-inspector-error" role="alert">
						{error}
					</p>
					<button
						type="button"
						className="desktop-start"
						onClick={() => setRetryGeneration((generation) => generation + 1)}
					>
						Restart terminal
					</button>
				</div>
			) : connected ? null : (
				<div className="terminal-inspector-notice">
					<p className="desktop-inspector-status">Starting terminal…</p>
				</div>
			)}
			<div
				ref={containerRef}
				className="terminal-inspector-frame"
				data-connected={connected ? "true" : "false"}
			/>
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
