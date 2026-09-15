import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { terminalWebsocketPlugin } from "./src/server/terminal-vite-plugin.ts";

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	plugins: [
		tanstackStart(),
		viteReact(),
		tailwindcss(),
		terminalWebsocketPlugin(),
	],
});

export default config;
