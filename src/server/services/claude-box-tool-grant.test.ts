import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	type BoxToolIdentityStore,
	grantClaudeBoxTools,
	releaseClaudeBoxToolIdentity,
	sweepClaudeBoxToolIdentities,
} from "./claude-box-tool-grant";
import type { WorkspaceMachines } from "./workspace-machines";

const VM = WorkspaceId("vm-1");

function machines(
	options: {
		user?: string;
		revokeFails?: boolean;
		mint?: (
			record: (id: string) => Promise<boolean>,
		) => Promise<{ identityId: string; token: string } | null>;
		identities?: false;
	} = {},
) {
	const calls: string[] = [];
	const revoke = vi.fn(async (id: string) => {
		calls.push(`revoke ${id}`);
		if (options.revokeFails) throw new Error("provider down");
	});
	const mint = vi.fn(
		async (
			vm: WorkspaceId,
			user: string,
			record: (id: string) => Promise<boolean>,
		) => {
			calls.push(`mint ${vm} ${user}`);
			if (options.mint) return options.mint(record);
			return (await record("ident_new"))
				? { identityId: "ident_new", token: "fs-token" }
				: null;
		},
	);
	const value = {
		ensureRunning: vi.fn(async (vm: WorkspaceId) => {
			calls.push(`start ${vm}`);
			return vm;
		}),
		exec: vi.fn(async () => ({
			exitCode: 0,
			stdout: `${options.user ?? "ubuntu"}\n`,
			stderr: "",
		})),
		...(options.identities === false
			? {}
			: { boxToolIdentities: { mint, revoke } }),
	} as unknown as WorkspaceMachines;
	return { value, calls, mint, revoke };
}

function store(current: string | null = null) {
	let held = current;
	const value: BoxToolIdentityStore = {
		current: vi.fn(async () => held),
		record: vi.fn(async (id: string) => {
			if (held) return false;
			held = id;
			return true;
		}),
		clear: vi.fn(async (id: string) => {
			if (held === id) held = null;
		}),
	};
	return { value, held: () => held };
}

describe("Claude box tool grants", () => {
	it("starts the VM, reads its default user and mints an identity for that VM and user", async () => {
		const fake = machines();
		const turn = store();
		const grant = await grantClaudeBoxTools({
			machines: fake.value,
			vm: VM,
			store: turn.value,
		});
		expect(grant).toEqual({
			vmId: "vm-1",
			linuxUser: "ubuntu",
			token: "fs-token",
		});
		expect(fake.calls).toEqual(["start vm-1", "mint vm-1 ubuntu"]);
		expect(turn.held()).toBe("ident_new");
	});

	it("grants a turn with runtime secrets only when the VM can redact them itself", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ready = machines();
		const grant = await grantClaudeBoxTools({
			machines: ready.value,
			vm: VM,
			store: store().value,
			redactOnVm: true,
		});
		// The fake VM answers the probe with exit 0 and no marker: not ready.
		expect(grant).toBeNull();
		expect(ready.mint).not.toHaveBeenCalled();
		const probing = machines();
		(probing.value.exec as ReturnType<typeof vi.fn>).mockImplementation(
			async (_vm: unknown, command: string) =>
				command === "id -un"
					? { exitCode: 0, stdout: "ubuntu\n", stderr: "" }
					: { exitCode: 0, stdout: "", stderr: "\nytimesy-vm-redaction:0\n" },
		);
		expect(
			await grantClaudeBoxTools({
				machines: probing.value,
				vm: VM,
				store: store().value,
				redactOnVm: true,
			}),
		).toEqual({
			vmId: "vm-1",
			linuxUser: "ubuntu",
			token: "fs-token",
			redactOnVm: true,
		});
		const probe = (probing.value.exec as ReturnType<typeof vi.fn>).mock
			.calls[1]?.[1] as string;
		expect(probe).toContain("/var/tmp/ytimesy-secrets/agent.env");
		// No secrets: no probe, granted as before.
		const plain = machines();
		await grantClaudeBoxTools({
			machines: plain.value,
			vm: VM,
			store: store().value,
		});
		expect(plain.value.exec).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});

	it("deletes the previous run's identity first, so one token lives per run", async () => {
		const fake = machines();
		const turn = store("ident_old");
		await grantClaudeBoxTools({
			machines: fake.value,
			vm: VM,
			store: turn.value,
		});
		expect(fake.calls).toEqual([
			"revoke ident_old",
			"start vm-1",
			"mint vm-1 ubuntu",
		]);
		expect(turn.held()).toBe("ident_new");
	});

	it("leaves the run on the edge when the previous identity cannot be deleted", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fake = machines({ revokeFails: true });
		const turn = store("ident_old");
		expect(
			await grantClaudeBoxTools({
				machines: fake.value,
				vm: VM,
				store: turn.value,
			}),
		).toBeNull();
		expect(fake.mint).not.toHaveBeenCalled();
		// Kept for the sweep: an id that could not be deleted is never forgotten.
		expect(turn.held()).toBe("ident_old");
		warn.mockRestore();
	});

	it("refuses an unreadable Linux user and a provider without identities", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const odd = machines({ user: "root; rm -rf /" });
		expect(
			await grantClaudeBoxTools({
				machines: odd.value,
				vm: VM,
				store: store().value,
			}),
		).toBeNull();
		expect(odd.mint).not.toHaveBeenCalled();
		expect(
			await grantClaudeBoxTools({
				machines: machines({ identities: false }).value,
				vm: VM,
				store: store().value,
			}),
		).toBeNull();
		warn.mockRestore();
	});

	it("never logs the token", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fake = machines({
			mint: async () => {
				throw new Error("mint failed");
			},
		});
		await grantClaudeBoxTools({
			machines: fake.value,
			vm: VM,
			store: store().value,
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("fs-token");
		warn.mockRestore();
	});

	it("releases the turn's identity, and keeps its id for the sweep when the delete fails", async () => {
		const ok = machines();
		const turn = store("ident_1");
		await releaseClaudeBoxToolIdentity({
			machines: ok.value,
			store: turn.value,
		});
		expect(ok.calls).toEqual(["revoke ident_1"]);
		expect(turn.held()).toBeNull();

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failing = machines({ revokeFails: true });
		const kept = store("ident_2");
		await expect(
			releaseClaudeBoxToolIdentity({
				machines: failing.value,
				store: kept.value,
			}),
		).resolves.toBeUndefined();
		expect(kept.held()).toBe("ident_2");
		warn.mockRestore();
	});

	it("sweeps the identities of turns that stopped running, one failure not stopping the rest", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fake = machines();
		fake.revoke.mockImplementation(async (id: string) => {
			if (id === "ident_b") throw new Error("provider down");
		});
		const clear = vi.fn(async () => {});
		const deleted = await sweepClaudeBoxToolIdentities({
			machines: fake.value,
			stale: async () => [
				{ turnId: "t-a", identityId: "ident_a" },
				{ turnId: "t-b", identityId: "ident_b" },
				{ turnId: "t-c", identityId: "ident_c" },
			],
			clear,
		});
		expect(deleted).toBe(2);
		expect(clear.mock.calls).toEqual([
			["t-a", "ident_a"],
			["t-c", "ident_c"],
		]);
		warn.mockRestore();
	});
});
