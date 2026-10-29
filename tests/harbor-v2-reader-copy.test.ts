import { execFileSync, spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readerCopyCommand } from "../evals/harbor_v2/trial";

let directory = "";
afterEach(async () => {
	if (directory) {
		await chmod(join(directory, "app", "tool"), 0o700).catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});

// rs-archive-clone ships an execute-only binary the non-root trial user may
// run but not read; a plain cp -a failed on it and no reader could start.
it("copies a checkout for a reader, leaving out files the user may not read", async () => {
	directory = await mkdtemp(join(tmpdir(), "reader-copy-"));
	const app = join(directory, "app");
	await mkdir(join(app, "src"), { recursive: true });
	await writeFile(join(app, "src", "main.rs"), "fn main() {}\n");
	await writeFile(join(app, "tool"), "#!/bin/sh\necho ok\n");
	await chmod(join(app, "tool"), 0o111);
	const copy = join(directory, "readers", "r1", "checkout");
	const run = spawnSync("sh", ["-c", readerCopyCommand(app, copy)], {
		encoding: "utf8",
	});
	expect(run.status).toBe(0);
	expect(run.stderr).toMatch(/skipped 1 unreadable file/);
	expect(await readFile(join(copy, "src", "main.rs"), "utf8")).toBe(
		"fn main() {}\n",
	);
	expect(execFileSync("ls", [copy]).toString()).not.toMatch(/cp-errors/);
});

it("still fails, with the reason, when the copy breaks for another cause", async () => {
	directory = await mkdtemp(join(tmpdir(), "reader-copy-"));
	await mkdir(join(directory, "app"));
	await writeFile(join(directory, "app", "tool"), "x");
	const run = spawnSync(
		"sh",
		[
			"-c",
			readerCopyCommand(
				join(directory, "missing"),
				join(directory, "out", "checkout"),
			),
		],
		{ encoding: "utf8" },
	);
	expect(run.status).toBe(1);
	expect(run.stderr).toMatch(/No such file/i);
});
