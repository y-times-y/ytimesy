/** A line or line range after a path: ":12", ":12-34", ":12–34", ":12:5", "#L12-L34". */
const LINES = /(?::(\d+)(?:[-–—](\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)$/;

/** A workspace file a chat names, and the lines it points at, if any. */
export type FileReference = {
	readonly path: string;
	readonly lines: string | null;
};

/**
 * Extensions of files an answer names. A `word.word` is only a file when the
 * second word is one of these: `process.env`, `Date.now` and `ytimesy.com`
 * are not, and a chip for them opens "no file".
 */
const FILE_EXTENSIONS = new Set(
	(
		"ts tsx js jsx mjs cjs mts cts json jsonc json5 md mdx markdown css scss sass less html htm " +
		"vue svelte astro py pyi rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish " +
		"yml yaml toml ini cfg conf sql graphql gql prisma proto lock txt csv tsv svg png jpg " +
		"jpeg gif webp ico pdf wasm tf tfvars xml gradle ipynb dockerfile patch diff"
	).split(" "),
);
/** Files without an extension that an answer names by name. */
const EXTENSIONLESS_FILES = new Set([
	"Dockerfile",
	"Makefile",
	"LICENSE",
	"README",
	"CHANGELOG",
	"CODEOWNERS",
	"Procfile",
	"Gemfile",
	"Rakefile",
	"AGENTS",
	"CLAUDE",
]);
/** Product names, not files: `Node.js`, `Next.js`. */
const PRODUCT_NAME =
	/^(node|next|vue|three|chart|express|d3|react|nuxt|deno|nest|p5|alpine|ember|moment)\.js$/i;

/**
 * Whether a path an answer names is plausibly a file, or a folder written
 * with its trailing slash. Git refs (`origin/main`), `owner/repo`, branch
 * names and bare folders (`src/server`) are not: a chip for them can only
 * open "no file".
 */
function plausibleWorkspacePath(path: string): boolean {
	if (path.endsWith("/")) return true;
	const name = path.split("/").filter(Boolean).at(-1) ?? "";
	if (!name) return false;
	if (PRODUCT_NAME.test(name) && !path.includes("/")) return false;
	if (EXTENSIONLESS_FILES.has(name)) return true;
	// A dotfile (.gitignore, .env.example): a name that starts with a dot.
	if (/^\.[A-Za-z0-9][\w.-]*$/.test(name)) return true;
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return false;
	const extension = name.slice(dot + 1).toLowerCase();
	// `process.env` is code; `.secrets/production.env` is a file (it has a folder).
	if (extension === "env") return path.includes("/");
	return FILE_EXTENSIONS.has(extension);
}

export function workspaceFileReference(value: string): FileReference | null {
	const text = value.trim();
	if (!text || /\s/.test(text) || text.includes("*") || text.startsWith("//"))
		return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("#")) return null;
	const match = LINES.exec(text);
	const path = match ? text.slice(0, match.index) : text;
	if (!path || !plausibleWorkspacePath(path)) return null;
	const start = match?.[1] ?? match?.[3];
	const end = match?.[2] ?? match?.[4];
	return {
		path,
		lines: start ? (end && end !== start ? `${start}–${end}` : start) : null,
	};
}

/** The file's path, without any line range, or null when it is not a file. */
export function workspaceFileMention(value: string): string | null {
	return workspaceFileReference(value)?.path ?? null;
}

function fileName(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

/**
 * "executor.ts:510–525": the file's name and lines, for a chip. A name that
 * two different paths share (`shared`) keeps its folder: "services/archive.ts".
 */
export function fileReferenceLabel(
	reference: FileReference,
	shared: ReadonlySet<string> = new Set(),
): string {
	const parts = reference.path.split("/").filter(Boolean);
	const name = fileName(reference.path);
	const label =
		shared.has(name) && parts.length > 1 ? parts.slice(-2).join("/") : name;
	return reference.lines ? `${label}:${reference.lines}` : label;
}

/** File names that more than one path in this markdown ends with. */
export function sharedFileNames(markdown: string): Set<string> {
	const paths = new Map<string, Set<string>>();
	const candidates = [
		...markdown.matchAll(/`([^`\n]+)`/g),
		...markdown.matchAll(/\]\(([^)\s]+)\)/g),
	];
	for (const [, value] of candidates) {
		const reference = workspaceFileReference(value ?? "");
		if (!reference) continue;
		const name = fileName(reference.path);
		const seen = paths.get(name) ?? new Set();
		seen.add(reference.path.replace(/^\.?\//, ""));
		paths.set(name, seen);
	}
	return new Set(
		[...paths].filter(([, seen]) => seen.size > 1).map(([name]) => name),
	);
}
