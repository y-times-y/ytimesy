// Keeps a runner box's disk from filling. The box keeps each chat's Claude
// session file (it can be hundreds of MB) so follow-up turns resume from it;
// storage holds only a small copy, so deleting a file loses that session's
// history on this box (the chat falls back to its last messages). Hence: files
// go by age first, and by least-recently-used only when the disk is nearly
// full. Anything touched in the last hour belongs to a run in progress.
import { readdir, rm, stat, statfs } from "node:fs/promises";
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

/** Removes what is no longer needed; returns what it removed. `usage` is injectable for tests. */
export async function cleanup({
	home,
	now = Date.now(),
	usage = diskUsedShare,
	...overrides
}) {
	const limits = { ...CLEANUP_DEFAULTS, ...overrides };
	const removed = { runs: 0, sessions: 0, bytes: 0 };
	const runs = join(home, ".ytimesy/claude-runs");
	for (const turn of await entries(runs)) {
		const path = join(runs, turn);
		const info = await stat(path).catch(() => null);
		const touched = info ? (await newestFile(path)) || info.mtimeMs : 0;
		if (info && now - touched > limits.runMaxAgeMs) {
			await rm(path, { recursive: true, force: true });
			removed.runs++;
		}
	}
	const idle = (file) => now - file.mtime > limits.activeWindowMs;
	let files = await sessionFiles(home);
	for (const file of files.filter((file) => now - file.mtime > limits.sessionMaxAgeMs)) {
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
	console.log(JSON.stringify(await cleanup({ home })));
}
