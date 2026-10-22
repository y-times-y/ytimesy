import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { WorkspaceId } from "../../src/domain/ids";
import { posixShellQuoted as quote } from "../../src/domain/posix-command";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";

/**
 * The bridge's side of the Harbor protocol (same wire format as the frozen
 * v13 bridge, benchmarks/harbor/builder-bridge.ts): requests are single
 * stdout lines prefixed with HARBOR_REQUEST; the Python agent answers with
 * one JSON line on stdin per request. Every command runs in Harbor's own
 * task container through environment.exec, so the sandbox, timeouts and
 * grading stay Harbor's.
 */
export const HARBOR_REQUEST = "@@YTIMESY_HARBOR@@";

/** Base64 characters per write command: well under Linux's 128 KiB per argument, a multiple of 4. */
export const WRITE_CHUNK_CHARS = 64_000;

export type HarborReply = {
	id: number;
	exitCode: number;
	stdout?: string;
	stderr?: string;
};

export function harborChannel(input: { stdin: Readable; stdout: Writable }) {
	const pending = new Map<number, (reply: HarborReply) => void>();
	let nextId = 1;
	let closed = false;
	const lines = createInterface({ input: input.stdin });
	// The agent side is gone: every waiting and later command fails at once
	// instead of hanging the trial.
	lines.on("close", () => {
		closed = true;
		for (const [id, resolve] of pending)
			resolve({
				id,
				exitCode: 124,
				stderr: "The Harbor agent closed the channel.",
			});
		pending.clear();
	});
	lines.on("line", (line) => {
		let reply: HarborReply;
		try {
			reply = JSON.parse(line) as HarborReply;
		} catch {
			return;
		}
		pending.get(reply.id)?.(reply);
		pending.delete(reply.id);
	});
	const send = (message: Record<string, unknown>) =>
		input.stdout.write(`${HARBOR_REQUEST}${JSON.stringify(message)}\n`);
	const exec = (command: string, timeoutMs: number) =>
		new Promise<HarborReply>((resolve) => {
			const id = nextId++;
			if (closed) {
				resolve({
					id,
					exitCode: 124,
					stderr: "The Harbor agent closed the channel.",
				});
				return;
			}
			pending.set(id, resolve);
			send({ id, op: "exec", command, timeoutMs });
		});
	return { exec, send };
}

/** Only the operations the builder tools use; files travel as base64. */
export function harborMachines(
	exec: (command: string, timeoutMs: number) => Promise<HarborReply>,
): WorkspaceMachines {
	return {
		exec: async (_vm: WorkspaceId, command: string, timeoutMs = 120_000) => {
			const reply = await exec(command, timeoutMs);
			return {
				exitCode: reply.exitCode,
				stdout: reply.stdout ?? "",
				stderr: reply.stderr ?? "",
			};
		},
		readTextFile: async (_vm: WorkspaceId, path: string) => {
			const reply = await exec(
				`test -f ${quote(path)} && base64 < ${quote(path)} | tr -d '\\n'`,
				30_000,
			);
			return reply.exitCode
				? null
				: Buffer.from((reply.stdout ?? "").trim(), "base64").toString("utf8");
		},
		// The file travels inside the command, and Linux caps one argument at
		// 128 KiB (MAX_ARG_STRLEN): a 423 KB report (563 KB of base64) failed
		// every edit with "Could not write". Larger files go in pieces
		// appended to a side file, then moved into place.
		writeTextFile: async (_vm: WorkspaceId, path: string, contents: string) => {
			const encoded = Buffer.from(contents).toString("base64");
			const fail = (reply: HarborReply) => {
				if (reply.exitCode)
					throw new Error(
						`Could not write ${path}: ${(reply.stderr ?? "").slice(-300)}`.trim(),
					);
			};
			const mkdir = `mkdir -p "$(dirname ${quote(path)})"`;
			if (encoded.length <= WRITE_CHUNK_CHARS) {
				fail(
					await exec(
						`${mkdir} && printf %s ${encoded} | base64 -d > ${quote(path)}`,
						30_000,
					),
				);
				return;
			}
			const part = `${path}.ytimesy-part-${process.pid}-${Date.now()}`;
			try {
				for (let at = 0; at < encoded.length; at += WRITE_CHUNK_CHARS) {
					const piece = encoded.slice(at, at + WRITE_CHUNK_CHARS);
					fail(
						await exec(
							at === 0
								? `${mkdir} && printf %s ${piece} | base64 -d > ${quote(part)}`
								: `printf %s ${piece} | base64 -d >> ${quote(part)}`,
							30_000,
						),
					);
				}
				fail(await exec(`mv -f ${quote(part)} ${quote(path)}`, 30_000));
			} catch (error) {
				await exec(`rm -f ${quote(part)}`, 30_000).catch(() => {});
				throw error;
			}
		},
	} as unknown as WorkspaceMachines;
}
