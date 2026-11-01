import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { ImportedSessionRow } from "../adapters/local-imports";
import {
	handoffSessionsForMachine,
	materializeHandoffHistory,
} from "./handoff-history";
import type { WorkspaceMachines } from "./workspace-machines";

const vm = WorkspaceId("vm-1");
const PROJECT = "11111111-1111-4111-8111-111111111111";

function session(
	id: string,
	overrides: Partial<ImportedSessionRow> = {},
): ImportedSessionRow {
	return {
		id: `${id}0000000-0000-4000-8000-000000000000`.slice(0, 36),
		projectId: PROJECT,
		tool: "claude",
		sourceSessionId: `local-${id}`,
		title: `Session ${id}`,
		turnCount: 3,
		sourceUpdatedAt: new Date("2026-10-31T00:00:00Z"),
		transcriptBytes: 10,
		...overrides,
	};
}

function fakeMachines(present = "") {
	const exec = vi.fn(async (_vm: WorkspaceId, command: string) => ({
		exitCode: 0,
		stdout: command.includes("for m in") ? present : "",
		stderr: "",
	}));
	const writeTextFile = vi.fn(
		async (_vm: WorkspaceId, _path: string, _contents: string) => {},
	);
	return {
		machines: { exec, writeTextFile } as unknown as WorkspaceMachines,
		exec,
		writeTextFile,
	};
}

it("puts the newest transcripts on the machine within its budget", () => {
	const old = session("a", {
		sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
		transcriptBytes: 50,
	});
	const recent = session("b", { transcriptBytes: 60 });
	const missing = session("c", { transcriptBytes: null });
	expect(
		handoffSessionsForMachine([old, recent, missing], 100).map((row) => row.id),
	).toEqual([recent.id]);
});

it("extracts each missing transcript into its folder and writes INDEX.md", async () => {
	const { machines, exec, writeTextFile } = fakeMachines();
	const read = vi.fn(async () => new Uint8Array([0x1f, 0x8b, 1, 2, 3]));
	const row = session("a");
	await materializeHandoffHistory(machines, vm, "alice", [row], read);
	expect(read).toHaveBeenCalledWith(
		{ userId: "alice", projectId: PROJECT },
		row.id,
		"transcript.tgz",
	);
	const extract = exec.mock.calls.find(([, command]) =>
		command.includes("tar -xzf"),
	)?.[1];
	expect(extract).toContain(`"$HOME/.ytimesy/handoff"`);
	expect(extract).toContain(`"$d/"'claude-local-a'`);
	expect(extract).toContain("--no-same-owner");
	expect(extract).toContain(`.imported/"'${row.id}-10'`);
	const index = writeTextFile.mock.calls.find(([, path]) =>
		path.endsWith("INDEX.md"),
	)?.[2];
	expect(index).toContain(
		"| Claude Code | 2026-10-31 | Session a | 3 | claude-local-a/transcript.md |",
	);
});

it("does not write a transcript the machine already has", async () => {
	const row = session("a");
	const { machines, exec } = fakeMachines(`${row.id}-10\n`);
	const read = vi.fn();
	await materializeHandoffHistory(machines, vm, "alice", [row], read);
	expect(read).not.toHaveBeenCalled();
	expect(exec.mock.calls.some(([, c]) => c.includes("tar -xzf"))).toBe(false);
});

it("keeps going when one transcript cannot be read", async () => {
	const { machines, writeTextFile } = fakeMachines();
	const read = vi
		.fn()
		.mockRejectedValueOnce(new Error("storage down"))
		.mockResolvedValueOnce(new Uint8Array([0x1f, 0x8b]));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await materializeHandoffHistory(
		machines,
		vm,
		"alice",
		[session("a"), session("b", { sourceUpdatedAt: new Date("2026-01-01") })],
		read,
	);
	warn.mockRestore();
	const index = writeTextFile.mock.calls.at(-1)?.[2];
	expect(index).toContain("(not on this machine)");
	expect(index).toContain("claude-local-b/transcript.md");
});
