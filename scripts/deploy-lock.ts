import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One production deploy at a time on this machine (every agent session and
 * the owner deploy from it). Two overlapping deploys once replaced each
 * other's Workers mid smoke check, and the check rolled both back
 * (2026-11-04). The lock names its holder; a lock whose process is gone is
 * taken over.
 */
export function acquireDeployLock(
	name: string,
	options: {
		readonly path?: string;
		readonly pid?: number;
		readonly alive?: (pid: number) => boolean;
	} = {},
) {
	const path = options.path ?? join(homedir(), `.ytimesy-${name}-deploy.lock`);
	const pid = options.pid ?? process.pid;
	const alive = options.alive ?? processAlive;
	try {
		writeFileSync(
			path,
			JSON.stringify({ pid, since: new Date().toISOString() }),
			{
				flag: "wx",
			},
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const holder = readHolder(path);
		if (holder && alive(holder.pid))
			throw new Error(
				`Another ${name} deploy is running (pid ${holder.pid}, since ${holder.since}). Wait for it to finish; if no deploy is running, delete ${path}.`,
			);
		writeFileSync(
			path,
			JSON.stringify({ pid, since: new Date().toISOString() }),
		);
	}
	const release = () => {
		const holder = readHolder(path);
		if (holder?.pid === pid) rmSync(path, { force: true });
	};
	return release;
}

function readHolder(path: string): { pid: number; since: string } | null {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return typeof value?.pid === "number" ? value : null;
	} catch {
		return null;
	}
}

function processAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
