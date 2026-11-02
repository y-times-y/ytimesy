import { describe, expect, it, vi } from "vitest";
import type {
	MemoryCommitOutcome,
	MemoryRepo,
	MemorySnapshot,
} from "../adapters/memory-repos";
import { commitMemoryEdit, lastDreamChange } from "./memory-edit";

const TOOLING = "projects/acme-web--7/tooling.md";
const first: MemorySnapshot = {
	head: "h1",
	files: { [TOOLING]: "# Tooling\n- Uses pnpm [added: 2026-10-01]\n" },
};

function repo(
	snapshots: MemorySnapshot[],
	outcomes: MemoryCommitOutcome[],
	extra: Partial<MemoryRepo> = {},
) {
	return {
		name: "memory-u1",
		snapshot: vi.fn(async () => snapshots.shift() ?? first),
		snapshotAt: async () => first,
		commit: vi.fn(
			async (): Promise<MemoryCommitOutcome> =>
				outcomes.shift() ?? { ok: true, hash: "h9" },
		),
		credentials: async () => ({ remote: "r", token: "t" }),
		history: async () => [],
		destroy: async () => {},
		...extra,
	} satisfies MemoryRepo;
}

describe("manual memory edits", () => {
	it("commits an added line once with an explanatory message", async () => {
		const memory = repo([first], []);
		expect(
			await commitMemoryEdit(
				memory,
				{
					op: "add",
					text: "Use httpx",
					project: "acme-web--7",
					always: false,
					topic: TOOLING,
				},
				"2026-10-21",
			),
		).toEqual({
			ok: true,
			added: { path: TOOLING, line: 3, text: "Use httpx" },
		});
		expect(memory.commit).toHaveBeenCalledTimes(1);
		expect(memory.commit).toHaveBeenCalledWith(
			first,
			[
				{
					path: TOOLING,
					content:
						"# Tooling\n- Uses pnpm [added: 2026-10-01]\n- Use httpx [source: manual; added: 2026-10-21]\n",
				},
			],
			"Add memory (project acme-web): Use httpx",
		);
	});

	it("applies the edit again to a concurrent change, and reports a line that is gone", async () => {
		const moved: MemorySnapshot = {
			head: "h2",
			files: {
				[TOOLING]:
					"# Tooling\n- Runs vitest\n- Uses pnpm [added: 2026-10-01]\n",
			},
		};
		const memory = repo(
			[first],
			[{ ok: false, reason: "conflict", current: moved }],
		);
		const ref = { path: TOOLING, line: 2, text: "Uses pnpm" };
		expect(
			await commitMemoryEdit(memory, { op: "delete", ref }, "2026-10-21"),
		).toEqual({ ok: true });
		expect(memory.commit).toHaveBeenLastCalledWith(
			moved,
			[{ path: TOOLING, content: "# Tooling\n- Runs vitest\n" }],
			"Delete memory: Uses pnpm",
		);
		const gone = repo(
			[{ head: "h3", files: { [TOOLING]: "# Tooling\n" } }],
			[],
		);
		expect(
			await commitMemoryEdit(gone, { op: "delete", ref }, "2026-10-21"),
		).toEqual({ ok: false, error: "Memory no longer has that line." });
		expect(gone.commit).not.toHaveBeenCalled();
	});

	it("summarises the newest dream commit against its parent", async () => {
		const before = {
			"api.md": "# API\n- Errors are problem+json\n- Uses tabs\n",
		};
		const after = {
			"api.md": "# API\n- Errors are problem+json\n- Timestamps are UTC\n",
		};
		const memory = repo([], [], {
			log: async () => [
				{ hash: "c3", message: "Undo memory: x", committedAt: 3, parent: "c2" },
				{
					hash: "c2",
					message: "Dream: retire tabs note, add UTC\n",
					committedAt: Date.parse("2026-10-20T10:00:00Z"),
					parent: "c1",
				},
			],
			snapshotAt: async (hash) => ({
				head: hash,
				files: hash === "c2" ? after : before,
			}),
		});
		expect(await lastDreamChange(memory, "2026-10-21")).toEqual({
			at: "2026-10-20T10:00:00.000Z",
			message: "retire tabs note, add UTC",
			summary: {
				added: ["Timestamps are UTC"],
				merged: [],
				expired: [],
				resolved: [],
				removed: ["Uses tabs"],
			},
		});
		expect(await lastDreamChange(repo([], []), "2026-10-21")).toBeNull();
	});
});
