import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquireDeployLock } from "../scripts/deploy-lock";

const lockPath = () =>
	join(mkdtempSync(join(tmpdir(), "deploy-lock-")), "lock");

it("refuses a second deploy while the first runs, and frees the lock when it ends", () => {
	const path = lockPath();
	const release = acquireDeployLock("production", {
		path,
		pid: 100,
		alive: () => true,
	});
	expect(() =>
		acquireDeployLock("production", { path, pid: 200, alive: () => true }),
	).toThrow(/Another production deploy is running \(pid 100/);
	release();
	expect(existsSync(path)).toBe(false);
	const next = acquireDeployLock("production", {
		path,
		pid: 200,
		alive: () => true,
	});
	next();
});

it("takes over a lock whose deploy is gone, and never deletes another holder's lock", () => {
	const path = lockPath();
	const crashed = acquireDeployLock("production", {
		path,
		pid: 100,
		alive: () => false,
	});
	const release = acquireDeployLock("production", {
		path,
		pid: 200,
		alive: () => false,
	});
	// The crashed deploy's late cleanup leaves the new holder's lock alone.
	crashed();
	expect(existsSync(path)).toBe(true);
	release();
	expect(existsSync(path)).toBe(false);
});
