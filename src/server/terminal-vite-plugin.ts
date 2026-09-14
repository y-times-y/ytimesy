import type { Plugin } from "vite";

export function terminalWebsocketPlugin(): Plugin {
	return {
		name: "ytimesy-terminal-ws",
		configureServer(server) {
			return attachLoadedTerminal(server);
		},
		configurePreviewServer(server) {
			return attachLoadedTerminal(server);
		},
	};
}

function attachLoadedTerminal(server: {
	httpServer?: unknown;
	ssrLoadModule?: (url: string) => Promise<Record<string, unknown>>;
}) {
	return () => {
		const httpServer = server.httpServer;
		if (!httpServer || typeof server.ssrLoadModule !== "function") return;
		void server.ssrLoadModule("/src/server/terminal-ws.ts").then((mod) => {
			const attach = mod.attachTerminalUpgrade;
			if (typeof attach === "function") attach(httpServer);
		});
	};
}
