export type FileKind =
	| "typescript"
	| "tsx"
	| "javascript"
	| "jsx"
	| "json"
	| "markdown"
	| "css"
	| "html"
	| "python"
	| "yaml"
	| "shell"
	| "rust"
	| "go"
	| "toml"
	| "svg"
	| "image"
	| "lock"
	| "config"
	| "test"
	| "unknown";

const EXTENSION_KIND: Record<string, FileKind> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	json: "json",
	md: "markdown",
	mdx: "markdown",
	css: "css",
	scss: "css",
	sass: "css",
	less: "css",
	html: "html",
	htm: "html",
	py: "python",
	yml: "yaml",
	yaml: "yaml",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	rs: "rust",
	go: "go",
	toml: "toml",
	svg: "svg",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	ico: "image",
	lock: "lock",
};

const BASENAME_KIND: Record<string, FileKind> = {
	dockerfile: "config",
	makefile: "config",
	license: "markdown",
	".gitignore": "config",
	".npmrc": "config",
	".nvmrc": "config",
	"package.json": "json",
	"tsconfig.json": "json",
	"pnpm-lock.yaml": "lock",
	"package-lock.json": "lock",
	"bun.lock": "lock",
	"cargo.lock": "lock",
	"yarn.lock": "lock",
};

export function fileBasename(path: string): string {
	const trimmed = path.replace(/\\/g, "/");
	const parts = trimmed.split("/");
	return parts[parts.length - 1] ?? path;
}

const VSCODE_ICON_BY_BASENAME: Record<string, string> = {
	dockerfile: "file-type-docker",
	makefile: "file-type-config",
	license: "file-type-license",
	".gitignore": "file-type-git",
	".npmrc": "file-type-npm",
	".nvmrc": "file-type-npm",
	"package.json": "file-type-npm",
	"package-lock.json": "file-type-npm",
	"tsconfig.json": "file-type-tsconfig",
	"pnpm-lock.yaml": "file-type-pnpm",
	"yarn.lock": "file-type-yarn",
	"bun.lock": "file-type-bun",
	"cargo.lock": "file-type-rust",
};

const VSCODE_ICON_BY_EXT: Record<string, string> = {
	ts: "file-type-typescript",
	mts: "file-type-typescript",
	cts: "file-type-typescript",
	tsx: "file-type-reactts",
	js: "file-type-js",
	mjs: "file-type-js",
	cjs: "file-type-js",
	jsx: "file-type-reactjs",
	json: "file-type-json",
	md: "file-type-markdown",
	mdx: "file-type-markdown",
	css: "file-type-css",
	scss: "file-type-scss",
	sass: "file-type-sass",
	less: "file-type-less",
	html: "file-type-html",
	htm: "file-type-html",
	py: "file-type-python",
	yml: "file-type-yaml",
	yaml: "file-type-yaml",
	sh: "file-type-shell",
	bash: "file-type-shell",
	zsh: "file-type-shell",
	rs: "file-type-rust",
	go: "file-type-go",
	toml: "file-type-toml",
	svg: "catppuccin:svg",
	png: "catppuccin:image",
	jpg: "catppuccin:image",
	jpeg: "catppuccin:image",
	gif: "catppuccin:image",
	webp: "catppuccin:image",
	ico: "catppuccin:image",
	lock: "file-type-yarn",
};

export function vscodeFileIconName(path: string): string {
	const basename = fileBasename(path);
	const lower = basename.toLowerCase();
	const named = VSCODE_ICON_BY_BASENAME[lower];
	if (named) return fileTypeIconId(named);
	if (/\.(?:test|spec)\.tsx$/i.test(basename)) {
		return fileTypeIconId("file-type-testts");
	}
	if (/\.(?:test|spec)\.ts$/i.test(basename)) {
		return fileTypeIconId("file-type-testts");
	}
	if (/\.(?:test|spec)\.jsx?$/i.test(basename)) {
		return fileTypeIconId("file-type-testjs");
	}
	if (path.includes("/__tests__/")) return fileTypeIconId("file-type-jest");
	const dot = lower.lastIndexOf(".");
	if (dot <= 0) return fileTypeIconId("default-file");
	return fileTypeIconId(
		VSCODE_ICON_BY_EXT[lower.slice(dot + 1)] ?? "default-file",
	);
}

function fileTypeIconId(name: string): string {
	return name.includes(":") ? name : `vscode-icons:${name}`;
}

export function fileKindFromPath(path: string): FileKind {
	const basename = fileBasename(path);
	const lower = basename.toLowerCase();
	if (
		/\.(?:test|spec)\.[^.]+$/i.test(basename) ||
		path.includes("/__tests__/")
	) {
		return "test";
	}
	const named = BASENAME_KIND[lower];
	if (named) return named;
	const dot = lower.lastIndexOf(".");
	if (dot <= 0) return "unknown";
	return EXTENSION_KIND[lower.slice(dot + 1)] ?? "unknown";
}

export function fileKindBadge(kind: FileKind): string {
	switch (kind) {
		case "typescript":
			return "TS";
		case "tsx":
			return "TX";
		case "javascript":
			return "JS";
		case "jsx":
			return "JX";
		case "json":
			return "{}";
		case "markdown":
			return "MD";
		case "css":
			return "CSS";
		case "html":
			return "<>";
		case "python":
			return "PY";
		case "yaml":
			return "YML";
		case "shell":
			return ">_";
		case "rust":
			return "RS";
		case "go":
			return "GO";
		case "toml":
			return "TM";
		case "svg":
			return "SVG";
		case "image":
			return "IMG";
		case "lock":
			return "LCK";
		case "config":
			return "CFG";
		case "test":
			return "TST";
		case "unknown":
			return "";
	}
}
