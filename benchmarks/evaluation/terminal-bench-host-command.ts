import { randomUUID } from "node:crypto";
import type { ExecOptions, ExecResult } from "freestyle";
import { z } from "zod";
import { posixShellQuoted as quote } from "../../src/domain/posix-command";
import type { CommandOutput } from "../../src/server/services/workspace-machines";

type Host = { exec(options: ExecOptions): Promise<ExecResult> };

/** Freestyle requests cap at five minutes; owned long jobs retain their actual exit and output. */
export async function terminalBenchHostCommand(
	host: Host,
	command: string,
	timeoutMs: number,
): Promise<CommandOutput> {
	const bounded = Math.max(1000, Math.min(timeoutMs, 1820000));
	const wrapped = `timeout --signal=TERM --kill-after=5s ${Math.max(1, Math.ceil((bounded - 10000) / 1000))} bash -lc ${quote(command)}`;
	if (bounded <= 300000) {
		const result = await host.exec({ command: wrapped, timeoutMs: bounded });
		return {
			exitCode: result.statusCode ?? 124,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	}
	const directory = `/tmp/ytimesy-benchmark-command-${randomUUID()}`;
	const job = `${wrapped} >${quote(`${directory}/stdout`)} 2>${quote(`${directory}/stderr`)}; result=$?; printf '%s' "$result" >${quote(`${directory}/status`)}`;
	const launch = await host.exec({
		command: `umask 077; mkdir ${quote(directory)} || exit 1; nohup bash -lc ${quote(job)} >/dev/null 2>&1 </dev/null &`,
		timeoutMs: 15000,
	});
	if (launch.statusCode !== 0)
		throw new Error("Long benchmark command launch was not confirmed.");
	const read =
		"import json,pathlib,sys; p=pathlib.Path(sys.argv[1]); s=p/'status'; sys.exit(3) if not s.exists() else print(json.dumps({'exitCode':int(s.read_text()),'stdout':(p/'stdout').read_text(errors='replace'),'stderr':(p/'stderr').read_text(errors='replace')}))";
	const deadline = Date.now() + bounded;
	while (Date.now() < deadline) {
		const result = await host.exec({
			command: `python3 -c ${quote(read)} ${quote(directory)}`,
			timeoutMs: 15000,
		});
		if (result.statusCode === 0)
			return z
				.object({
					exitCode: z.number().int(),
					stdout: z.string(),
					stderr: z.string(),
				})
				.parse(JSON.parse(result.stdout ?? ""));
		if (result.statusCode !== 3)
			throw new Error("Long benchmark command observation failed.");
		await new Promise((done) => setTimeout(done, 2000));
	}
	throw new Error(
		"Long benchmark command exceeded its frozen deadline; owned VM cleanup is required.",
	);
}
