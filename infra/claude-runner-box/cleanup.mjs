// Keeps a runner box's disk from filling. The box keeps each chat's Claude
// session file (it can be hundreds of MB) so follow-up turns resume from it;
// storage holds only a small copy, so deleting a file loses that session's
// history on this box (the chat falls back to its last messages). Hence: files
// go by age first, and by least-recently-used only when the disk is nearly
// full. Anything touched in the last hour belongs to a run in progress.
import { readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { basename } from "node:path";
import { join } from "node:path";

const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

export const CLEANUP_DEFAULTS = {
	/** Session files idle this long are removed. */
	sessionMaxAgeMs: 7 * DAY,
	/** A turn's run directory is only needed while that turn runs. */
	runMaxAgeMs: 3 * DAY,
	/** Above this share of the disk used, evict least-recently-used sessions... */
	highWatermark: 0.85,
	/** ...until the share used is back under this. */
	lowWatermark: 0.7,
	activeWindowMs: HOUR,
};

async function entries(directory) {
	try {
		return await readdir(directory);
	} catch {
		return [];
	}
}

/** The newest modification time of any file under a directory (its own when it holds none). */
async function newestFile(directory) {
	let newest = 0;
	for (const name of await entries(directory)) {
		const path = join(directory, name);
		const info = await stat(path).catch(() => null);
		if (!info) continue;
		newest = Math.max(newest, info.isDirectory() ? await newestFile(path) : info.mtimeMs);
	}
	return newest;
}

async function sessionFiles(home) {
	const projects = join(home, ".ytimesy/claude-code/projects");
	const files = [];
	for (const project of await entries(projects))
		for (const name of await entries(join(projects, project)))
			if (name.endsWith(".jsonl")) {
				const path = join(projects, project, name);
				const info = await stat(path).catch(() => null);
				if (info?.isFile()) files.push({ path, size: info.size, mtime: info.mtimeMs });
			}
	return files;
}

async function diskUsedShare(home) {
	const info = await statfs(home);
	return 1 - info.bavail / info.blocks;
}

/** Protect live runs even while a long tool call leaves its transcript untouched. */
async function activeWork(home, scopeRoot, processRoot) {
	const turns = new Set();
	const sessions = new Set();
	const runs = join(home, ".ytimesy/claude-runs");
	for (const turn of await entries(runs)) {
		if (!/^[a-f0-9-]{36}$/i.test(turn)) continue;
		try {
			const current = (await readFile(join(runs, turn, "current"), "utf8")).trim();
			if (!/^\d{1,4}$/.test(current)) continue;
			const directory = join(runs, turn, current);
			if (await stat(join(directory, "status")).catch(() => null)) continue;
			const saved = JSON.parse(await readFile(join(scopeRoot, turn, `cc-${turn}-${current}.json`), "utf8"));
			if (!Number.isSafeInteger(saved.pid) || saved.pid <= 1) continue;
			const info = await readFile(join(processRoot, String(saved.pid), "stat"), "utf8");
			const start = info.slice(info.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
			if (start !== String(saved.start)) continue;
			turns.add(turn);
			const initialized = (await readFile(join(directory, "active-session"), "utf8").catch(() => "")).trim();
			const session = initialized || JSON.parse(await readFile(join(directory, "options.json"), "utf8")).resume;
			if (/^[a-f0-9-]{36}$/i.test(session ?? "")) sessions.add(`${session}.jsonl`);
		} catch { /* A finished or not-yet-launched command has no live process record. */ }
	}
	return { turns, sessions };
}

/** Removes what is no longer needed; returns what it removed. `usage` is injectable for tests. */
export async function cleanup({
	home,
	now = Date.now(),
	usage = diskUsedShare,
	scopeRoot = "/tmp/ytimesy-api-command-scopes",
	processRoot = "/proc",
	...overrides
}) {
	const limits = { ...CLEANUP_DEFAULTS, ...overrides };
	const removed = { runs: 0, sessions: 0, bytes: 0 };
	const active = await activeWork(home, scopeRoot, processRoot);
	const runs = join(home, ".ytimesy/claude-runs");
	for (const turn of await entries(runs)) {
		if (active.turns.has(turn)) continue;
		const path = join(runs, turn);
		const info = await stat(path).catch(() => null);
		const touched = info ? (await newestFile(path)) || info.mtimeMs : 0;
		if (info && now - touched > limits.runMaxAgeMs) {
			await rm(path, { recursive: true, force: true });
			removed.runs++;
		}
	}
	const protectedSession = (file) => active.sessions.has(basename(file.path));
	const idle = (file) => !protectedSession(file) && now - file.mtime > limits.activeWindowMs;
	let files = await sessionFiles(home);
	for (const file of files.filter((file) => !protectedSession(file) && now - file.mtime > limits.sessionMaxAgeMs)) {
		await rm(file.path, { force: true });
		removed.sessions++;
		removed.bytes += file.size;
	}
	files = await sessionFiles(home);
	if ((await usage(home)) >= limits.highWatermark) {
		for (const file of files.filter(idle).sort((a, b) => a.mtime - b.mtime)) {
			if ((await usage(home)) < limits.lowWatermark) break;
			await rm(file.path, { force: true });
			removed.sessions++;
			removed.bytes += file.size;
		}
	}
	return removed;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const home = process.env.RUNNER_HOME ?? "/var/lib/ytimesy-runner";
	const removed = await cleanup({ home });
	console.log(JSON.stringify(removed));
	const share = await diskUsedShare(home);
	if (share >= 0.8)
		console.warn(JSON.stringify({ level: "warn", message: "Runner disk above 80% used after cleanup", usedShare: Number(share.toFixed(3)) }));
}
