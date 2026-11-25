import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Builds one stylesheet with every rule the preview's components import. */
export default defineConfig({
	root: resolve(import.meta.dirname, "../.."),
	logLevel: "warn",
	resolve: { tsconfigPaths: true },
	plugins: [tailwindcss(), viteReact()],
	build: {
		outDir: process.env.PREVIEW_CSS_DIR ?? "/tmp/ytimesy-preview-css",
		emptyOutDir: true,
		cssCodeSplit: false,
		rollupOptions: { input: resolve(import.meta.dirname, "entry.gen.ts") },
	},
});
