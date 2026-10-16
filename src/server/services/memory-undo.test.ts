import { describe, expect, it, vi } from "vitest";
import type {
	MemoryCommitOutcome,
	MemoryRepo,
	MemorySnapshot,
} from "../adapters/memory-repos";
import { removeMemoryLine } from "./memory-undo";

const line = { path: "tooling.md", text: "Runs vitest" };
const withLine: MemorySnapshot = {
	head: "h1",
	files: {
		"tooling.md": "# tooling\n- Uses pnpm\n- Runs vitest [source: x]\n",
	},
};

function repo(snapshots: MemorySnapshot[], outcomes: MemoryCommitOutcome[]) {
	return {
		name: "memory-u1",
		snapshot: vi.fn(async () => snapshots.shift() ?? withLine),
		snapshotAt: async () => withLine,
		commit: vi.fn(
			async (): Promise<MemoryCommitOutcome> =>
				outcomes.shift() ?? { ok: true, hash: "h9" },
		),
		credentials: async () => ({ remote: "r", token: "t" }),
		history: async () => [],
		destroy: async () => {},
	} satisfies MemoryRepo;
}

describe("Undo of a saved memory line", () => {
	it("removes the line with one commit through the memory repo writer", async () => {
		const memory = repo([withLine], [{ ok: true, hash: "h2" }]);
		expect(await removeMemoryLine(memory, line)).toEqual({ removed: true });
		expect(memory.commit).toHaveBeenCalledWith(
			withLine,
			[{ path: "tooling.md", content: "# tooling\n- Uses pnpm\n" }],
			"Undo memory: Runs vitest",
		);
	});

	it("re-reads memory once after a concurrent edit", async () => {
		const moved: MemorySnapshot = {
			head: "h3",
			files: {
				"tooling.md": "# tooling\n- Runs vitest [source: x]\n- Uses bun\n",
			},
		};
		const memory = repo(
			[withLine, moved],
			[
				{ ok: false, reason: "conflict", current: moved },
				{ ok: true, hash: "h4" },
			],
		);
		expect(await removeMemoryLine(memory, line)).toEqual({ removed: true });
		expect(memory.commit).toHaveBeenLastCalledWith(
			moved,
			[{ path: "tooling.md", content: "# tooling\n- Uses bun\n" }],
			"Undo memory: Runs vitest",
		);
	});

	it("commits nothing when the line is already gone", async () => {
		const memory = repo(
			[{ head: "h5", files: { "tooling.md": "# tooling\n- Uses pnpm\n" } }],
			[],
		);
		expect(await removeMemoryLine(memory, line)).toEqual({ removed: false });
		expect(memory.commit).not.toHaveBeenCalled();
	});
});
