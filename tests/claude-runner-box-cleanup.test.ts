import { existsSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanup } from "../infra/claude-runner-box/cleanup.mjs";

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

async function file(path: string, ageMs: number, bytes = 10) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, "x".repeat(bytes));
	const at = (NOW - ageMs) / 1000;
	await utimes(path, at, at);
}

describe("runner box cleanup", () => {
	it("removes idle session files and old run directories, keeping the rest", async () => {
		const home = await mkdtemp(join(tmpdir(), "box-"));
		const projects = join(home, ".ytimesy/claude-code/projects/-var-work");
		await file(join(projects, "old.jsonl"), 8 * DAY);
		await file(join(projects, "recent.jsonl"), 2 * DAY);
		await file(join(home, ".ytimesy/claude-runs/old-turn/1/out"), 4 * DAY);
		await file(join(home, ".ytimesy/claude-runs/new-turn/1/out"), HOUR);
		const removed = await cleanup({ home, now: NOW, usage: async () => 0.1 });
		expect(removed).toMatchObject({ sessions: 1, bytes: 10 });
		expect(existsSync(join(projects, "old.jsonl"))).toBe(false);
		expect(existsSync(join(projects, "recent.jsonl"))).toBe(true);
		expect(existsSync(join(home, ".ytimesy/claude-runs/old-turn"))).toBe(false);
		expect(existsSync(join(home, ".ytimesy/claude-runs/new-turn"))).toBe(true);
	});

	it("when the disk is nearly full evicts the least recently used sessions, never one in use", async () => {
		const home = await mkdtemp(join(tmpdir(), "box-"));
		const projects = join(home, ".ytimesy/claude-code/projects/-var-work");
		await file(join(projects, "a.jsonl"), 5 * DAY, 100);
		await file(join(projects, "b.jsonl"), 3 * DAY, 100);
		await file(join(projects, "c.jsonl"), 1 * DAY, 100);
		await file(join(projects, "running.jsonl"), 60_000, 100);
		// The disk never frees up here, so every idle file goes; the one in use stays.
		await cleanup({ home, now: NOW, usage: async () => 0.95 });
		expect(existsSync(join(projects, "running.jsonl"))).toBe(true);
		for (const name of ["a", "b", "c"])
			expect(existsSync(join(projects, `${name}.jsonl`))).toBe(false);
	});

	it("stops evicting once the disk is back under the low watermark", async () => {
		const home = await mkdtemp(join(tmpdir(), "box-"));
		const projects = join(home, ".ytimesy/claude-code/projects/-var-work");
		await file(join(projects, "a.jsonl"), 5 * DAY, 100);
		await file(join(projects, "b.jsonl"), 3 * DAY, 100);
		await file(join(projects, "c.jsonl"), 1 * DAY, 100);
		let used = 0.95;
		await cleanup({
			home,
			now: NOW,
			usage: async () => {
				const current = used;
				used -= 0.15;
				return current;
			},
		});
		expect(existsSync(join(projects, "a.jsonl"))).toBe(false);
		expect(existsSync(join(projects, "c.jsonl"))).toBe(true);
	});
});
