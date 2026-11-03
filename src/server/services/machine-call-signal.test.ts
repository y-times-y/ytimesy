import { expect, it, vi } from "vitest";
import { callSignalFetch } from "../adapters/freestyle/abortable-fetch";
import { cancellableMachines, machineCallSignal } from "./machine-call-signal";
import type { WorkspaceMachines } from "./workspace-machines";

const hang = () => new Promise<never>(() => {});

it("rejects a live call at abort and aborts its provider requests", async () => {
	const turn = new AbortController();
	let requestSignal: AbortSignal | null | undefined;
	const transport = vi.fn<typeof fetch>(
		(_url, init) =>
			new Promise((_resolve, reject) => {
				requestSignal = init?.signal;
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			}),
	);
	const fetcher = callSignalFetch(transport);
	const machines = cancellableMachines(
		{
			exec: async () => {
				await fetcher("https://provider.test/exec");
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		} as unknown as WorkspaceMachines,
		turn.signal,
	);
	const call = machines.exec("vm" as never, "guard", 30_000);
	await Promise.resolve();
	turn.abort(new Error("Stopped"));
	await expect(call).rejects.toThrow("Stopped");
	expect(requestSignal?.aborted).toBe(true);
});

it("runs calls made after the abort normally, so cleanup still reaches the VM", async () => {
	const turn = new AbortController();
	turn.abort(new Error("Stopped"));
	const seen: (AbortSignal | undefined)[] = [];
	const machines = cancellableMachines(
		{
			exec: async () => {
				seen.push(machineCallSignal());
				return { exitCode: 0, stdout: "", stderr: "" };
			},
		} as unknown as WorkspaceMachines,
		turn.signal,
	);
	await expect(machines.exec("vm" as never, "stop commands")).resolves.toEqual({
		exitCode: 0,
		stdout: "",
		stderr: "",
	});
	expect(seen).toEqual([undefined]);
});

it("leaves other users of the same machines untouched", async () => {
	const turn = new AbortController();
	const exec = vi.fn(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		return {
			exitCode: 0,
			stdout: machineCallSignal() ? "turn" : "plain",
			stderr: "",
		};
	});
	const shared = { exec } as unknown as WorkspaceMachines;
	const mine = cancellableMachines(shared, turn.signal);
	const theirs = shared.exec("vm" as never, "checkpoint");
	const ours = mine.exec("vm" as never, "tool");
	ours.catch(() => {});
	turn.abort(new Error("Stopped"));
	await expect(theirs).resolves.toMatchObject({ stdout: "plain" });
	await expect(ours).rejects.toThrow("Stopped");
	// A request outside a turn's call carries no turn signal.
	const transport = vi.fn<typeof fetch>(async () => new Response("ok"));
	await callSignalFetch(transport)("https://provider.test/list");
	expect(transport.mock.calls[0]?.[1]?.signal).toBeUndefined();
});

it("keeps hanging work from blocking the caller once aborted", async () => {
	const turn = new AbortController();
	const machines = cancellableMachines(
		{ ensureRunning: hang } as unknown as WorkspaceMachines,
		turn.signal,
	);
	const started = Date.now();
	const call = machines.ensureRunning("vm" as never);
	setTimeout(() => turn.abort(new Error("Stopped")), 10);
	await expect(call).rejects.toThrow("Stopped");
	expect(Date.now() - started).toBeLessThan(1_000);
});
