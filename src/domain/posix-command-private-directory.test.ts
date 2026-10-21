import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { privateDirectoryShell } from "./posix-command";

const run = promisify(execFile);
const sh = (path: string) =>
	run("sh", ["-c", privateDirectoryShell(path)]).then(
		() => 0,
		(error: { code: number }) => error.code,
	);

it("creates a 0700 directory, tightens one we own, and refuses symlinks and files", async () => {
	const root = await mkdtemp(join(tmpdir(), "private-dir-"));
	try {
		const fresh = join(root, "fresh");
		expect(await sh(fresh)).toBe(0);
		expect((await lstat(fresh)).mode & 0o777).toBe(0o700);

		const loose = join(root, "loose");
		await mkdir(loose);
		await chmod(loose, 0o777);
		expect(await sh(loose)).toBe(0);
		expect((await lstat(loose)).mode & 0o777).toBe(0o700);

		const link = join(root, "link");
		await symlink(fresh, link);
		expect(await sh(link)).toBe(1);

		const file = join(root, "file");
		await run("touch", [file]);
		expect(await sh(file)).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("refuses a directory owned by another user", async () => {
	// /  is root-owned and not 0700 for an ordinary test user.
	if (process.getuid?.() === 0) return;
	expect(await sh("/")).toBe(1);
});

it("guest capability installs refuse a pre-created directory and do not trust its ready file", async () => {
	const { guestCapabilityCommand } = await import(
		"#/server/services/guest-node-capability"
	);
	const install = guestCapabilityCommand("browser", "", {});
	expect(install).not.toContain("mkdir -p");
	expect(install).toContain("install -d -m 0700");
	const installed = guestCapabilityCommand(
		"browser",
		"",
		{},
		{
			onlyInstalled: true,
		},
	);
	expect(installed).toMatch(/-user "\$\(id -u\)" -perm 700.*ready/);
});
