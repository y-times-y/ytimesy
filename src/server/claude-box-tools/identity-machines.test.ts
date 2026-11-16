import { spawn } from "node:child_process";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "box-upload-"));
	temporary.push(path);
	return path;
}
const guestShell: GuestExec = ({ command, stdin }) =>
	new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command]);
		const stdout: Buffer[] = [],
			stderr: Buffer[] = [];
		child.stdout.on("data", (data: Buffer) => stdout.push(data));
		child.stderr.on("data", (data: Buffer) => stderr.push(data));
		child.once("error", reject);
		child.once("close", (statusCode) =>
			resolve({
				statusCode,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
			}),
		);
		child.stdin.on("error", () => {});
		child.stdin.end(
			stdin === undefined ? undefined : Buffer.from(stdin, "base64"),
		);
	});

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
		const exec = vi.fn<GuestExec>(guestShell);
		const { machines } = machinesWith(exec);
		const contents = `${"é".repeat(500_000)}end`;
		const root = await directory();
		const target = join(root, "a b", "file.txt");
		await machines.writeTextFile(VM, target, contents);
		expect(await readFile(target, "utf8")).toBe(contents);
		const calls = exec.mock.calls.map(([options]) => options);
		expect(calls[0]?.command).toContain("tempfile.mkdtemp");
		expect(calls.at(-2)?.command).toContain("os.replace");
		expect(await readdir(join(root, "a b"))).toEqual(["file.txt"]);
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
		const exec = vi.fn<GuestExec>(guestShell);
		const { machines } = machinesWith(exec);
		const root = await directory();
		await machines.writeTextFile(VM, join(root, "empty"), "");
		expect(await readFile(join(root, "empty"), "utf8")).toBe("");
		expect(exec).toHaveBeenCalledOnce();
		expect(await machines.readTextFile(VM, join(root, "missing"))).toBeNull();
	});

	it("preserves the old file if a later upload chunk fails, and removes staging", async () => {
		const root = await directory();
		const target = join(root, "keep.txt");
		await writeFile(target, "original bytes");
		const exec: GuestExec = async (options) => {
			if (options.command.includes("cat >>"))
				return { statusCode: 1, stderr: "injected disk failure" };
			return guestShell(options);
		};
		await expect(
			machinesWith(exec).machines.writeTextFile(
				VM,
				target,
				"new".repeat(400_000),
			),
		).rejects.toThrow("injected disk failure");
		expect(await readFile(target, "utf8")).toBe("original bytes");
		expect(await readdir(root)).toEqual(["keep.txt"]);
	});

	it("preserves executable permissions and follows an existing symlink without replacing it", async () => {
		const root = await directory();
		const nested = join(root, "other");
		await mkdir(nested);
		const target = join(nested, "run.sh");
		const link = join(root, "shortcut");
		await writeFile(target, "old");
		await chmod(target, 0o751);
		await symlink(target, link);
		await machinesWith(guestShell).machines.writeTextFile(
			VM,
			link,
			"#!/bin/sh\necho hello\n",
		);
		expect(await readFile(target, "utf8")).toBe("#!/bin/sh\necho hello\n");
		expect((await stat(target)).mode & 0o777).toBe(0o751);
		expect((await lstat(link)).isSymbolicLink()).toBe(true);
		expect(await readdir(root)).toEqual(["other", "shortcut"]);
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
