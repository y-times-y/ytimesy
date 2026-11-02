import { describe, expect, it, vi } from "vitest";
import { withMemoryChanges } from "#/domain/memory-repo";
import type {
	MemoryCommitOutcome,
	MemoryRepo,
	MemorySnapshot,
} from "../adapters/memory-repos";
import { ensureMemoryLayout, memoryInLayout } from "./memory-layout";

const legacy: MemorySnapshot = {
	head: "h1",
	files: {
		"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n",
		"tooling.md":
			"# tooling\n- Prefers tabs\n- Web pins Node 22 [project: acme/web]\n",
	},
};
const projects = async () => [{ fullName: "acme/web", repositoryIds: [7] }];

/** A repo whose commits apply, so later snapshots see them. */
function repo(start: MemorySnapshot, outcomes: MemoryCommitOutcome[] = []) {
	let current = start;
	return {
		name: "memory-u1",
		snapshot: vi.fn(async () => current),
		snapshotAt: async () => current,
		commit: vi.fn(
			async (
				base: MemorySnapshot,
				changes: readonly { path: string; content: string | null }[],
				_message: string,
			): Promise<MemoryCommitOutcome> => {
				const forced = outcomes.shift();
				if (forced) return forced;
				current = {
					head: `${base.head}+`,
					files: withMemoryChanges(base.files, changes),
				};
				return { ok: true, hash: current.head };
			},
		),
		credentials: async () => ({ remote: "r", token: "t" }),
		history: async () => [],
		destroy: async () => {},
	} satisfies MemoryRepo;
}

describe("moving memory into the per-project layout", () => {
	it("commits once on first access, then reads without writing", async () => {
		const memory = repo(legacy);
		const moved = await ensureMemoryLayout(memory, projects);
		expect(memory.commit).toHaveBeenCalledTimes(1);
		expect(memory.commit.mock.calls[0][2]).toBe("Reorganize memory by project");
		expect(Object.keys(moved.files).sort()).toEqual([
			".memory-layout",
			"MEMORY.md",
			"personal/tooling.md",
			"projects/acme-web--7/tooling.md",
		]);
		const again = await ensureMemoryLayout(memory, projects);
		expect(memory.commit).toHaveBeenCalledTimes(1);
		expect(again.files).toEqual(moved.files);
	});

	it("leaves a repo nobody wrote yet alone", async () => {
		const empty = repo({ head: null, files: {} });
		await ensureMemoryLayout(empty, projects);
		expect(empty.commit).not.toHaveBeenCalled();
	});

	it("re-reads once after a concurrent write and moves the newer state", async () => {
		const newer: MemorySnapshot = {
			head: "h2",
			files: { ...legacy.files, "people.md": "- Priya owns pricing\n" },
		};
		const memory = repo(legacy, [
			{ ok: false, reason: "conflict", current: newer },
		]);
		memory.snapshot.mockResolvedValueOnce(legacy).mockResolvedValueOnce(newer);
		const moved = await ensureMemoryLayout(memory, projects);
		expect(memory.commit).toHaveBeenCalledTimes(2);
		expect(moved.files["personal/people.md"]).toBe("- Priya owns pricing\n");
	});

	it("never fails a read: on an error the repo is read as it was", async () => {
		const memory = repo(legacy);
		memory.commit.mockRejectedValueOnce(new Error("network"));
		const read = await memoryInLayout(memory, projects);
		expect(read).toEqual(legacy);
	});
});
