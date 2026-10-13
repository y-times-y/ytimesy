import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { WorkspaceId } from "../src/domain/ids";
import {
	persistClaudeAuthSnapshotForUser,
	refreshClaudeAuthSnapshotForUser,
} from "../src/server/proof/persist-claude-auth-snapshot";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

const state = vi.hoisted(() => ({
	existing: "sh-old" as string | null,
	snapshot: vi.fn(() =>
		Effect.succeed({
			ok: true as const,
			snapshotId: "sh-new",
			public: false as const,
		}),
	),
	save: vi.fn(async (_userId: string, account: { snapshotId: string }) => {
		state.existing = account.snapshotId;
	}),
}));

vi.mock("../src/server/adapters/claude/login-session", () => ({
	snapshotAuthenticatedClaudeWorkspace: state.snapshot,
}));
vi.mock("../src/server/auth/agent-account", () => ({
	loadHarnessSnapshotId: async () => state.existing,
	saveConnectedAgentAccount: state.save,
}));

it("keeps an existing snapshot for ordinary reads but rotates it after a new login", async () => {
	const machines = {} as WorkspaceMachines;
	const vm = WorkspaceId("vm-login");
	const account = { planType: "pro" };
	const existing = await Effect.runPromise(
		persistClaudeAuthSnapshotForUser("alice", machines, vm, account),
	);
	expect(existing).toEqual({ kind: "existing", snapshotId: "sh-old" });
	expect(state.snapshot).not.toHaveBeenCalled();
	const replaced = await Effect.runPromise(
		refreshClaudeAuthSnapshotForUser("alice", machines, vm, account),
	);
	expect(replaced).toEqual({ kind: "replaced", snapshotId: "sh-new" });
	expect(state.save).toHaveBeenCalledWith(
		"alice",
		expect.objectContaining({ provider: "claude", snapshotId: "sh-new" }),
	);
});
