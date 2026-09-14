import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

export function TerminalInspector({
	projectId,
	active,
}: {
	projectId?: string;
	active: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		if (!active || !projectId || !containerRef.current) {
			setConnected(false);
			return;
		}
		const container = containerRef.current;
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
		fit.fit();
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const url = new URL(`${protocol}//${window.location.host}/api/terminal`);
		url.searchParams.set("projectId", projectId);
		url.searchParams.set("cols", String(term.cols));
		url.searchParams.set("rows", String(term.rows));
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		let closed = false;
		setError(null);
		socket.addEventListener("open", () => {
			if (closed) return;
			setConnected(true);
			socket.send(
				JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
			);
		});
		socket.addEventListener("message", (event) => {
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
		socket.addEventListener("close", () => {
			if (closed) return;
			setConnected(false);
		});
		socket.addEventListener("error", () => {
			if (closed) return;
			setError("Terminal disconnected. Retry from Tools.");
			setConnected(false);
		});
		const dataSub = term.onData((data) => {
			if (socket.readyState === WebSocket.OPEN) socket.send(data);
		});
		const observer = new ResizeObserver(() => {
			fit.fit();
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(
					JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
				);
			}
		});
		observer.observe(container);
		return () => {
			closed = true;
			observer.disconnect();
			dataSub.dispose();
			socket.close();
			term.dispose();
			setConnected(false);
		};
	}, [active, projectId]);

	if (!projectId) {
		return (
			<section className="inspector-empty" aria-live="polite">
				<h2>No terminal connected.</h2>
				<p>Select a project to use the terminal.</p>
			</section>
		);
	}

	if (!active) {
		return (
			<section className="inspector-empty" aria-live="polite">
				<h2>Terminal</h2>
				<p>Open Terminal to attach to the prepared workspace.</p>
			</section>
		);
	}

	return (
		<section className="terminal-inspector" aria-label="Workspace terminal">
			{error ? (
				<p className="terminal-inspector-error" role="alert">
					{error}
				</p>
			) : null}
			<div
				ref={containerRef}
				className="terminal-inspector-frame"
				data-connected={connected ? "true" : "false"}
			/>
		</section>
	);
}
