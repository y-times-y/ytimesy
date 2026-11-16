import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { VM_REDACTION_FAILED } from "#/domain/vm-secret-redaction";
import {
	BoxMachineRefused,
	BoxRedactedWrite,
	GUEST_EXEC_MAX_MS,
	type GuestExec,
	identityWorkspaceMachines,
} from "./identity-machines";

const VM = WorkspaceId("vm-1");

function machinesWith(exec: GuestExec) {
	const ran = vi.fn();
	return {
		ran,
		machines: identityWorkspaceMachines({ vmId: "vm-1", exec, onRan: ran }),
	};
}

describe("the runner box's identity machines", () => {
	it("maps exec onto the identity's exec, its limit capped at Freestyle's, a killed command as 124", async () => {
		const exec = vi.fn<GuestExec>(async () => ({
			stdout: "out",
			stderr: null,
			statusCode: null,
		}));
		const { machines, ran } = machinesWith(exec);
		expect(await machines.exec(VM, "make test", 900_000)).toEqual({
			exitCode: 124,
			stdout: "out",
			stderr: "",
		});
		expect(exec).toHaveBeenCalledWith({
			command: "make test",
			timeoutMs: GUEST_EXEC_MAX_MS,
		});
		expect(ran).toHaveBeenCalledOnce();
	});

	it("reaches only the granted VM", async () => {
		const exec = vi.fn<GuestExec>(async () => ({ statusCode: 0 }));
		const { machines } = machinesWith(exec);
		await expect(
			machines.exec(WorkspaceId("vm-other"), "true"),
		).rejects.toThrow("only the chat's own machine");
		expect(exec).not.toHaveBeenCalled();
	});

	it("tells a refusal before running (4xx) from an unknown outcome (5xx, network)", async () => {
		const failWith = (status?: number) =>
			machinesWith(async () => {
				throw Object.assign(new Error("failed"), status ? { status } : {});
			}).machines;
		await expect(failWith(409).exec(VM, "true")).rejects.toBeInstanceOf(
			BoxMachineRefused,
		);
		await expect(failWith(401).exec(VM, "true")).rejects.toBeInstanceOf(
			BoxMachineRefused,
		);
		for (const status of [408, 502, undefined]) {
			const error = await failWith(status)
				.exec(VM, "true")
				.catch((caught: unknown) => caught);
			expect(error).not.toBeInstanceOf(BoxMachineRefused);
		}
	});

	it("writes a file through stdin in pieces, creating its directory", async () => {
		const exec = vi.fn<GuestExec>(async () => ({ statusCode: 0 }));
		const { machines } = machinesWith(exec);
		const contents = `${"é".repeat(500_000)}end`;
		await machines.writeTextFile(VM, "/tmp/a b/file.txt", contents);
		const calls = exec.mock.calls.map(([options]) => options);
		expect(calls[0]?.command).toBe(
			`mkdir -p -- "$(dirname -- '/tmp/a b/file.txt')" && cat > '/tmp/a b/file.txt'`,
		);
		expect(
			calls.slice(1).every((call) => call.command.startsWith("cat >> ")),
		).toBe(true);
		const written = Buffer.concat(
			calls.map((call) => Buffer.from(call.stdin ?? "", "base64")),
		).toString("utf8");
		expect(written).toBe(contents);
		for (const call of calls)
			expect(
				Buffer.from(call.stdin ?? "", "base64").length,
			).toBeLessThanOrEqual(1024 * 1024);
	});

	it("writes an empty file and reads a missing one as null", async () => {
		const exec = vi.fn<GuestExec>(async ({ command }) =>
			command.startsWith("if [ -f")
				? { statusCode: 3, stdout: "" }
				: { statusCode: 0 },
		);
		const { machines } = machinesWith(exec);
		await machines.writeTextFile(VM, "/tmp/empty", "");
		expect(exec.mock.calls[0]?.[0].stdin).toBe("");
		expect(await machines.readTextFile(VM, "/tmp/missing")).toBeNull();
	});

	it("with runtime secrets, wraps each command for the VM's filter and strips its marker", async () => {
		const exec = vi.fn<GuestExec>(async () => ({
			statusCode: 0,
			stdout: "out [REDACTED]",
			stderr: "warn\nytimesy-vm-redaction:1\n",
		}));
		const onRedacted = vi.fn();
		const machines = identityWorkspaceMachines({
			vmId: "vm-1",
			exec,
			redactOnVm: { onRedacted },
		});
		expect(await machines.exec(VM, "make test")).toEqual({
			exitCode: 0,
			stdout: "out [REDACTED]",
			stderr: "warn",
		});
		const sent = exec.mock.calls[0]?.[0].command ?? "";
		expect(sent).toContain("\nmake test\n");
		expect(sent).toContain("python3 -c");
		expect(onRedacted).toHaveBeenCalledOnce();
	});

	it("with runtime secrets, refuses output the filter did not finish, and writes the caller refuses", async () => {
		const machines = identityWorkspaceMachines({
			vmId: "vm-1",
			exec: async () => ({ statusCode: null, stdout: "", stderr: "" }),
			redactOnVm: {
				beforeWrite: () => {
					throw new BoxRedactedWrite();
				},
			},
		});
		await expect(machines.exec(VM, "sleep 999")).rejects.toThrow(
			VM_REDACTION_FAILED,
		);
		await expect(
			machines.writeTextFile(VM, "/tmp/x", "a"),
		).rejects.toBeInstanceOf(BoxRedactedWrite);
	});

	it("cannot start, route or delete the VM", async () => {
		const { machines } = machinesWith(async () => ({ statusCode: 0 }));
		expect(await machines.ensureRunning(VM)).toBe("vm-1");
		expect(() => machines.destroy(VM)).toThrow("not available");
		expect(() => machines.exposeHttp(VM, 80, "x")).toThrow("not available");
	});
});
