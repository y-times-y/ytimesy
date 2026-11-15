import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const double = fileURLToPath(
	new URL("./github-collaboration-server.ts", import.meta.url),
);
/** Standalone component QA: never mounts the app server or accesses credentials. */
export default defineConfig({
	optimizeDeps: { entries: ["tests/fixtures/github-collaboration.html"] },
	resolve: {
		alias: [
			{ find: /^@tanstack\/react-start$/, replacement: double },
			{ find: /^.*\/pull-request-review\.fn$/, replacement: double },
			{ find: /^.*\/issue-chat\.fn$/, replacement: double },
			{ find: /^.*\/explorer\.fn$/, replacement: double },
			{
				find: "#",
				replacement: fileURLToPath(new URL("../../src", import.meta.url)),
			},
		],
	},
	plugins: [tailwindcss(), react()],
	server: { host: "127.0.0.1", port: 3101, strictPort: true },
});
