import { fileBasename } from "./file-kind";

export type SourceLanguage =
	| "javascript"
	| "python"
	| "json"
	| "css"
	| "html"
	| "shell"
	| "markdown"
	| "yaml"
	| "rust"
	| "go"
	| "plain";

const EXTENSION_LANGUAGE: Record<string, SourceLanguage> = {
	ts: "javascript",
	tsx: "javascript",
	mts: "javascript",
	cts: "javascript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	json: "json",
	css: "css",
	scss: "css",
	sass: "css",
	less: "css",
	html: "html",
	htm: "html",
	svg: "html",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	md: "markdown",
	mdx: "markdown",
	yml: "yaml",
	yaml: "yaml",
	toml: "yaml",
	rs: "rust",
	go: "go",
};

const FENCE_LANGUAGE: Record<string, SourceLanguage> = {
	ts: "javascript",
	tsx: "javascript",
	typescript: "javascript",
	js: "javascript",
	jsx: "javascript",
	javascript: "javascript",
	py: "python",
	python: "python",
	json: "json",
	css: "css",
	html: "html",
	svg: "html",
	sh: "shell",
	bash: "shell",
	shell: "shell",
	zsh: "shell",
	md: "markdown",
	markdown: "markdown",
	yml: "yaml",
	yaml: "yaml",
	toml: "yaml",
	rs: "rust",
	rust: "rust",
	go: "go",
	golang: "go",
};

export function sourceLanguageFromPath(path: string): SourceLanguage {
	const basename = fileBasename(path);
	const lower = basename.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot <= 0) return "plain";
	return EXTENSION_LANGUAGE[lower.slice(dot + 1)] ?? "plain";
}

export function sourceLanguageFromFence(tag: string | null): SourceLanguage {
	const key = tag?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	if (!key) return "javascript";
	return FENCE_LANGUAGE[key] ?? "plain";
}
