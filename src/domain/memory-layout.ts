import {
	isRetired,
	MEMORY_DIRECTORY,
	MEMORY_ENTRY,
	type MemoryChange,
	type MemoryFiles,
	type MemoryLine,
	memoryLinks,
	parseMemoryLine,
} from "./memory-repo";

/**
 * Where a memory line applies is where its file lives, so scope is the repo's
 * own folder structure:
 *
 *   MEMORY.md                       short index (filtered per project when attached)
 *   personal/<topic>.md             about the user, in every project
 *   projects/<project-key>/<topic>.md  one project only
 *
 * A project key is a readable slug of the repository's owner/name plus its
 * GitHub repository id (`acme-web--123456`), so a renamed repository keeps
 * its folder: the id decides, the slug is for people. Files anywhere else
 * are from before this layout ("legacy"): their `project:` metadata decides
 * until the lazy migration below moves them. Pure: no git, model or database.
 */

export const PERSONAL_FOLDER = "personal";
export const PROJECTS_FOLDER = "projects";
/** The layout version marker at the repo root (not a .md file, so never a memory). */
export const MEMORY_LAYOUT_MARKER = ".memory-layout";
export const MEMORY_LAYOUT_VERSION = "2";
/**
 * Second line of the marker while personal/ still holds lines the move put
 * there unsorted: the next dream reviews personal/ and clears it.
 */
const SORT_PENDING = "sort-personal: pending";

/** The marker as the move writes it: the version, and a sort still to do when lines went to personal/. */
export function layoutMarker(sortPending: boolean) {
	return `${MEMORY_LAYOUT_VERSION}\n${sortPending ? `${SORT_PENDING}\n` : ""}`;
}

/** Whether a dream still has to sort what the move put in personal/. */
export function personalSortPending(files: MemoryFiles) {
	return (files[MEMORY_LAYOUT_MARKER] ?? "").includes(SORT_PENDING);
}
export const MEMORY_LAYOUT_COMMIT = "Reorganize memory by project";

/** A project as memory knows it: its repositories decide its folder. */
export type MemoryProject = {
	readonly fullName: string;
	readonly name?: string | null;
	/** GitHub repository ids, primary first. */
	readonly repositoryIds: readonly number[];
};

export type MemoryPathScope =
	| { kind: "index" }
	| { kind: "personal" }
	| { kind: "project"; key: string }
	| { kind: "legacy" };

const KEY = /^[a-z0-9][a-z0-9-]{0,120}$/;
const KEY_ID = /--(\d{1,20})$/;

/** `y-times-y/ytimesy` -> `y-times-y-ytimesy`. */
export function projectSlug(fullName: string) {
	return (
		fullName
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, "-")
			.replaceAll(/^-+|-+$/g, "")
			.slice(0, 60)
			.replace(/-+$/, "") || "project"
	);
}

/** The folder name for a project: its slug and primary repository id. */
export function memoryProjectKey(project: MemoryProject) {
	const id = project.repositoryIds[0];
	const slug = projectSlug(project.fullName);
	return id ? `${slug}--${id}` : slug;
}

export function isMemoryProjectKey(value: string) {
	return KEY.test(value);
}

/** The repository id a key ends in, or null for a slug-only key. */
export function projectKeyId(key: string): number | null {
	const match = KEY_ID.exec(key);
	return match ? Number(match[1]) : null;
}

/** The key without its id: what a person reads. */
export function projectKeySlug(key: string) {
	return key.replace(KEY_ID, "");
}

export function projectFolderPath(key: string) {
	return `${PROJECTS_FOLDER}/${key}`;
}

export function memoryPathScope(path: string): MemoryPathScope {
	if (path === MEMORY_ENTRY) return { kind: "index" };
	const parts = path.split("/");
	if (parts[0] === PERSONAL_FOLDER && parts.length >= 2)
		return { kind: "personal" };
	if (parts[0] === PROJECTS_FOLDER && parts.length >= 3 && KEY.test(parts[1]))
		return { kind: "project", key: parts[1] };
	return { kind: "legacy" };
}

/** The folder of a scoped path (`personal`, `projects/<key>`), or null. */
export function memoryFolderOf(path: string): string | null {
	const scope = memoryPathScope(path);
	return scope.kind === "personal"
		? PERSONAL_FOLDER
		: scope.kind === "project"
			? projectFolderPath(scope.key)
			: null;
}

/** A topic file's name inside its folder: `projects/k/deploy.md` -> `deploy.md`. */
export function topicFileName(path: string) {
	const scope = memoryPathScope(path);
	const parts = path.split("/");
	const inner =
		scope.kind === "personal"
			? parts.slice(1)
			: scope.kind === "project"
				? parts.slice(2)
				: parts;
	return inner.join("-") || "notes.md";
}

/** Whether a project key names this project: by repository id, else by slug. */
export function keyMatchesProject(key: string, project: MemoryProject) {
	const id = projectKeyId(key);
	if (id !== null) return project.repositoryIds.includes(id);
	return projectKeySlug(key) === projectSlug(project.fullName);
}

/** Whether a legacy `project:` value names this project (owner/name, name, or repo name). */
export function projectNameMatches(value: string, project: MemoryProject) {
	const wanted = value.trim().toLowerCase();
	if (!wanted) return false;
	const full = project.fullName.toLowerCase();
	return (
		wanted === full ||
		wanted === (project.name ?? "").trim().toLowerCase() ||
		wanted === full.slice(full.lastIndexOf("/") + 1)
	);
}

/** Every project folder key in the repo. */
export function memoryProjectKeys(files: MemoryFiles): string[] {
	const keys = new Set<string>();
	for (const path of Object.keys(files)) {
		const scope = memoryPathScope(path);
		if (scope.kind === "project") keys.add(scope.key);
	}
	return [...keys].sort();
}

/**
 * The folder key this project's notes go to: an existing folder with one of
 * its repository ids (a renamed repo keeps its folder), else an existing
 * id-less folder with its slug, else a new key.
 */
export function projectKeyFor(files: MemoryFiles, project: MemoryProject) {
	const keys = memoryProjectKeys(files);
	return (
		keys.find(
			(key) => projectKeyId(key) !== null && keyMatchesProject(key, project),
		) ??
		keys.find(
			(key) => projectKeyId(key) === null && keyMatchesProject(key, project),
		) ??
		memoryProjectKey(project)
	);
}

/**
 * Whether a line applies to a chat in `project` (null: a chat without a
 * project). Personal lines apply everywhere; a project folder's lines only
 * in that project; legacy files by their `project:` key, untagged ones
 * everywhere. MEMORY.md is attached on its own (memoryIndexFor).
 */
export function lineInScope(
	entry: Pick<MemoryLine, "path" | "meta">,
	project: MemoryProject | null,
) {
	const scope = memoryPathScope(entry.path);
	switch (scope.kind) {
		case "index":
			return false;
		case "personal":
			return true;
		case "project":
			return Boolean(project && keyMatchesProject(scope.key, project));
		case "legacy":
			return entry.meta.project?.trim()
				? Boolean(project && projectNameMatches(entry.meta.project, project))
				: true;
	}
}

/** Whether a line belongs to one project (its folder, or a legacy `project:` key). */
export function isProjectLine(entry: Pick<MemoryLine, "path" | "meta">) {
	const scope = memoryPathScope(entry.path);
	return (
		scope.kind === "project" ||
		(scope.kind === "legacy" && Boolean(entry.meta.project?.trim()))
	);
}

/** Lines whose project folder (or tag) is this chat's: the project half of its scope. */
export function isThisProjectLine(
	entry: Pick<MemoryLine, "path" | "meta">,
	project: MemoryProject | null,
) {
	return (
		Boolean(project) && isProjectLine(entry) && lineInScope(entry, project)
	);
}

// ---- MEMORY.md as one chat sees it -------------------------------------------

/** MEMORY.md as attached: about 500 tokens at most. */
export const MEMORY_INDEX_CHARS = 2000;

/**
 * MEMORY.md for one chat: without other projects' index links and tagged
 * lines, clipped at a line boundary to `maxChars` with a pointer to the
 * rest. `lines` counts the non-empty lines kept.
 */
export function memoryIndexFor(
	content: string,
	project: MemoryProject | null,
	maxChars = MEMORY_INDEX_CHARS,
): { content: string; lines: number; clipped: number } {
	const linkInScope = (target: string) =>
		lineInScope({ path: target, meta: {} }, project);
	const kept: string[] = [];
	for (const raw of content.split("\n")) {
		const entry = parseMemoryLine(raw);
		if (
			entry?.meta.project?.trim() &&
			!(project && projectNameMatches(entry.meta.project, project))
		)
			continue;
		const links = memoryLinks(raw);
		if (!links.length) {
			kept.push(raw);
			continue;
		}
		const scoped = links.map((link) => ({
			link,
			keep: memoryPathScope(link).kind !== "project" || linkInScope(link),
		}));
		if (scoped.every((item) => item.keep)) {
			kept.push(raw);
			continue;
		}
		if (!scoped.some((item) => item.keep)) continue;
		// A line linking several folders keeps only this chat's links.
		let line = raw;
		for (const item of scoped)
			if (!item.keep) {
				const target = item.link.replace(/\.md$/, "");
				line = line.replace(
					new RegExp(
						`,?\\s*\\[\\[${escapeRegex(target)}(?:[#|][^\\]]*)?\\]\\]`,
					),
					"",
				);
			}
		kept.push(line.replace(/^(\s*[-*]\s+),\s*/, "$1"));
	}
	const out: string[] = [];
	let used = 0;
	let clipped = 0;
	for (const line of kept) {
		if (clipped || used + line.length + 1 > maxChars) {
			if (line.trim()) clipped++;
			continue;
		}
		out.push(line);
		used += line.length + 1;
	}
	if (clipped)
		out.push(
			`- … ${clipped} more ${clipped === 1 ? "line" : "lines"}: \`cat ${MEMORY_DIRECTORY}/${MEMORY_ENTRY}\``,
		);
	const text = out.join("\n").replace(/\n{3,}/g, "\n\n");
	return {
		content: text,
		lines: out.filter((line) => line.trim()).length,
		clipped,
	};
}

function escapeRegex(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- recall order ----------------------------------------------------------------

/**
 * Lines newest first (by `added:`, undated last, later lines first within a
 * date), so a cap on how many are ranked keeps the newest.
 */
export function byRecency(a: MemoryLine, b: MemoryLine) {
	return (
		(b.meta.added ?? "").localeCompare(a.meta.added ?? "") ||
		a.path.localeCompare(b.path) ||
		b.line - a.line
	);
}

// ---- migration ---------------------------------------------------------------------

/** Topic files outside personal/ and projects/<key>/ (MEMORY.md aside). */
export function legacyTopicFiles(files: MemoryFiles): string[] {
	return Object.keys(files)
		.filter(
			(path) => path.endsWith(".md") && memoryPathScope(path).kind === "legacy",
		)
		.sort();
}

/** Whether the repo still needs the per-project layout (marker missing, or stray files). */
export function needsMemoryLayout(files: MemoryFiles) {
	return (
		(files[MEMORY_LAYOUT_MARKER] ?? "").split("\n")[0].trim() !==
			MEMORY_LAYOUT_VERSION || legacyTopicFiles(files).length > 0
	);
}

/** The folder a legacy `project:` value goes to: the known project's key, else a slug. */
function legacyProjectKey(
	value: string,
	files: MemoryFiles,
	projects: readonly MemoryProject[],
) {
	const project = projects.find((candidate) =>
		projectNameMatches(value, candidate),
	);
	if (project) return projectKeyFor(files, project);
	const slug = projectSlug(value);
	return (
		memoryProjectKeys(files).find((key) => projectKeySlug(key) === slug) ?? slug
	);
}

function fileTitle(path: string, content: string) {
	return (
		/^#\s+(.+)$/m.exec(content)?.[1]?.trim() ||
		(path.split("/").pop() ?? path)
			.replace(/\.md$/, "")
			.replaceAll(/[-_]/g, " ")
	);
}

function withLines(existing: string | undefined, lines: readonly string[]) {
	const have = new Set((existing ?? "").split("\n").map((line) => line.trim()));
	const fresh = lines.filter((line) => !line.trim() || !have.has(line.trim()));
	if (!fresh.some((line) => line.trim())) return existing ?? null;
	const base = existing ?? "";
	const body = fresh.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
	return `${base}${base && !base.endsWith("\n") ? "\n" : ""}${body}\n`;
}

/**
 * Moves every legacy topic file into the layout, never dropping a line:
 * bullets with `project:` go to that project's folder (same topic name),
 * everything else (untagged bullets, headings, prose) to personal/, which a
 * dream then sorts into personal vs project. Lines keep their exact text.
 * Files already in the layout get only lines they lack (mixed repos), the
 * index's [[links]] follow the moves, and the version marker is written.
 * Null when there is nothing to do. Running it again changes nothing.
 */
export function memoryLayoutChanges(
	files: MemoryFiles,
	projects: readonly MemoryProject[],
): MemoryChange[] | null {
	if (!needsMemoryLayout(files)) return null;
	const next: MemoryFiles = { ...files };
	const moved = new Map<string, string[]>();
	let toSort = personalSortPending(files);
	for (const path of legacyTopicFiles(files)) {
		const content = files[path] ?? "";
		const name = topicFileName(path);
		const title = fileTitle(path, content);
		const personal: string[] = [];
		const byProject = new Map<string, string[]>();
		let personalBullets = 0;
		let prose = 0;
		for (const raw of content.split("\n")) {
			const entry = parseMemoryLine(raw);
			const project = entry?.meta.project?.trim();
			if (entry && project) {
				const key = legacyProjectKey(project, next, projects);
				byProject.set(key, [...(byProject.get(key) ?? []), raw]);
				continue;
			}
			if (entry) personalBullets++;
			else if (raw.trim() && !/^#{1,6}\s/.test(raw)) prose++;
			personal.push(raw);
		}
		const destinations: string[] = [];
		if (personalBullets) toSort = true;
		if (personalBullets || prose || !byProject.size) {
			const target = `${PERSONAL_FOLDER}/${name}`;
			const written = withLines(next[target], personal);
			if (written !== null) next[target] = written;
			destinations.push(target);
		}
		for (const [key, lines] of byProject) {
			const target = `${projectFolderPath(key)}/${name}`;
			const body =
				next[target] === undefined ? [`# ${title}`, "", ...lines] : lines;
			const written = withLines(next[target], body);
			if (written !== null) next[target] = written;
			destinations.push(target);
		}
		delete next[path];
		moved.set(path, destinations);
	}
	next[MEMORY_ENTRY] = reindexed(next[MEMORY_ENTRY], moved, next);
	next[MEMORY_LAYOUT_MARKER] = layoutMarker(toSort);
	const changes: MemoryChange[] = [];
	for (const path of new Set([...Object.keys(files), ...Object.keys(next)]))
		if ((files[path] ?? null) !== (next[path] ?? null))
			changes.push({ path, content: next[path] ?? null });
	return changes.length
		? changes.sort((a, b) => a.path.localeCompare(b.path))
		: null;
}

/** MEMORY.md with each moved file's [[link]] pointing at its new files, and unlinked new files listed. */
function reindexed(
	index: string | undefined,
	moved: ReadonlyMap<string, readonly string[]>,
	files: MemoryFiles,
) {
	let content = index ?? "# Memory\n\n## Index\n";
	content = content.replaceAll(
		/\[\[([^\]|#]+)((?:[#|][^\]]*)?)\]\]/g,
		(whole, target: string, rest: string) => {
			const trimmed = target.trim();
			const path = /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
			const destinations = moved.get(path);
			if (!destinations?.length) return whole;
			return destinations
				.map((destination) => `[[${destination.replace(/\.md$/, "")}${rest}]]`)
				.join(", ");
		},
	);
	const linked = new Set(memoryLinks(content));
	const missing = Object.keys(files)
		.filter(
			(path) =>
				path.endsWith(".md") &&
				path !== MEMORY_ENTRY &&
				memoryPathScope(path).kind !== "legacy" &&
				!linked.has(path),
		)
		.sort();
	if (!missing.length) return content;
	const links = missing.map((path) => `- [[${path.replace(/\.md$/, "")}]]`);
	return content.includes("## Index")
		? `${content.trimEnd()}\n${links.join("\n")}\n`
		: `${content.trimEnd()}\n\n## Index\n${links.join("\n")}\n`;
}

// ---- what a dream is told --------------------------------------------------------------

/** One project per line for the dream: its folder and its name. */
export function projectFolderListing(
	files: MemoryFiles,
	projects: readonly MemoryProject[],
) {
	const rows = new Map<string, string>();
	for (const project of projects)
		rows.set(projectKeyFor(files, project), project.fullName);
	for (const key of memoryProjectKeys(files))
		if (!rows.has(key)) rows.set(key, "(no longer a project)");
	return [...rows]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, name]) => `- ${projectFolderPath(key)}/ = ${name}`)
		.join("\n");
}

/** Normalized line text: the key a recall record is kept by. */
export function memoryRecallKey(text: string) {
	return text.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

const DAY = 86_400_000;
/** A line in memory this long and never recalled (since tracking began) is a retirement candidate. */
export const NEVER_RECALLED_DAYS = 45;
/** A line last recalled this long ago is too. */
export const LAST_RECALLED_DAYS = 90;

/**
 * Lines the read hook has not used for a long time, for a dream to retire
 * unless they still clearly matter. Days count from when recall tracking
 * began (`trackingSince`), so lines are not flagged for the time before it;
 * `scope: always` rules and retired lines are left out. Null tracking: none.
 */
export function staleMemoryLines(input: {
	files: MemoryFiles;
	today: string;
	/** Last recall date (YYYY-MM-DD) by memoryRecallKey of the line's text. */
	recalled: ReadonlyMap<string, string>;
	trackingSince: string | null;
	limit?: number;
}): string[] {
	if (!input.trackingSince) return [];
	const today = Date.parse(`${input.today}T00:00:00Z`);
	const since = Date.parse(`${input.trackingSince}T00:00:00Z`);
	if (Number.isNaN(today) || Number.isNaN(since)) return [];
	const out: string[] = [];
	for (const [path, content] of Object.entries(files(input.files))) {
		content.split("\n").forEach((raw, index) => {
			const entry = parseMemoryLine(raw, path, index + 1);
			if (!entry || isRetired(entry.meta, input.today)) return;
			if (entry.meta.scope?.toLowerCase() === "always") return;
			const last = input.recalled.get(memoryRecallKey(entry.text));
			if (last) {
				const at = Date.parse(`${last}T00:00:00Z`);
				if (today - at >= LAST_RECALLED_DAYS * DAY)
					out.push(`${path}:${index + 1}: ${entry.text} (last used ${last})`);
				return;
			}
			const added = Date.parse(`${entry.meta.added ?? ""}T00:00:00Z`);
			const from = Number.isNaN(added) ? since : Math.max(added, since);
			if (today - from >= NEVER_RECALLED_DAYS * DAY)
				out.push(`${path}:${index + 1}: ${entry.text} (never used)`);
		});
	}
	return out.slice(0, input.limit ?? 30);
}

function files(all: MemoryFiles) {
	return Object.fromEntries(
		Object.entries(all)
			.filter(([path]) => path.endsWith(".md") && path !== MEMORY_ENTRY)
			.sort(([a], [b]) => a.localeCompare(b)),
	);
}

/** An app project as memory scopes it. */
export function memoryProjectOf(project: {
	readonly fullName: string;
	readonly name?: string | null;
	readonly repositoryId: number;
	readonly repositories?: readonly { readonly repositoryId: number }[];
}): MemoryProject {
	const ids = [
		project.repositoryId,
		...(project.repositories ?? []).map((repo) => repo.repositoryId),
	];
	return {
		fullName: project.fullName,
		name: project.name ?? null,
		repositoryIds: [...new Set(ids.filter((id) => id > 0))],
	};
}
