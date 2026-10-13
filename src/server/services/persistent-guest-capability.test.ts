import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { LANGUAGE_INTELLIGENCE_SOURCE } from "./language-intelligence";
import { PERSISTENT_GUEST_SOURCE } from "./persistent-guest-capability";
import { STRUCTURED_CODE_READ_SOURCE } from "./structured-code-reads";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
it("authenticates a real reusable guest process, preserves per-request arguments and rejects browser origins", async () => {
	const packages = `/tmp/ytimesy-capability-language-${randomBytes(8).toString("hex")}`;
	let pid: number | undefined;
	try {
		await mkdir(packages, { mode: 0o700 });
		await symlink(`${process.cwd()}/node_modules`, `${packages}/node_modules`);
		await writeFile(`${packages}/package.json`, "{}");
		await writeFile(
			`${packages}/fixture.ts`,
			"export function greet() { return 'private-body'; }\n",
		);
		const bootstrap = async () =>
			JSON.parse(
				(
					await run(
						process.execPath,
						[
							"--input-type=module",
							"-e",
							PERSISTENT_GUEST_SOURCE,
							packages,
							JSON.stringify({ bootstrap: true }),
						],
						{ timeout: 10000 },
					)
				).stdout,
			);
		const first = await bootstrap();
		const origin = `http://127.0.0.1:${first.port}`;
		const invoke = async (source: string, input: object) => {
			const response = await fetch(`${origin}/execute`, {
				method: "POST",
				headers: { authorization: `Bearer ${first.token}` },
				body: JSON.stringify({ source, packages, input }),
			});
			return (await response.json()) as {
				exitCode: number;
				stdout: string;
				stderr: string;
			};
		};
		const identity = await invoke(
			"console.log(JSON.stringify({pid:process.pid,input:JSON.parse(process.argv[2])}));",
			{ value: 1 },
		);
		expect(identity.exitCode, identity.stderr).toBe(0);
		pid = JSON.parse(identity.stdout).pid;
		expect(JSON.parse(identity.stdout).input.value).toBe(1);
		const second = await bootstrap();
		expect(second).toEqual(first);
		const later = await invoke(
			"console.log(JSON.stringify({pid:process.pid,input:JSON.parse(process.argv[2])}));",
			{ value: 2 },
		);
		expect(JSON.parse(later.stdout)).toEqual({ pid, input: { value: 2 } });
		const outline = await invoke(STRUCTURED_CODE_READ_SOURCE, {
			cwd: packages,
			files: [{ path: "fixture.ts", view: "outline" }],
		});
		expect(outline.exitCode, outline.stderr).toBe(0);
		expect(JSON.parse(outline.stdout).files[0].declarations[0].name).toBe(
			"greet",
		);
		expect(outline.stdout).not.toContain("private-body");
		await writeFile(
			`${packages}/usage.ts`,
			'import {greet} from "./fixture";\ngreet();\n',
		);
		await writeFile(
			`${packages}/tsconfig.json`,
			'{"compilerOptions":{"strict":true}}',
		);
		const references = await invoke(LANGUAGE_INTELLIGENCE_SOURCE, {
			cwd: packages,
			path: "fixture.ts",
			operation: "references",
			line: 1,
			column: 17,
		});
		expect(references.exitCode, references.stderr).toBe(0);
		expect(JSON.parse(references.stdout).result).toHaveLength(3);
		const batch = await invoke(LANGUAGE_INTELLIGENCE_SOURCE, {
			cwd: packages,
			path: "fixture.ts",
			requests: [
				{ path: "fixture.ts", operation: "references", line: 1, column: 17 },
				{ path: "fixture.ts", operation: "hover", line: 1, column: 17 },
			],
		});
		expect(batch.exitCode, batch.stderr).toBe(0);
		expect(JSON.parse(batch.stdout).results[0].result).toHaveLength(3);
		expect(JSON.parse(batch.stdout).results[0].serverId).toBe(
			JSON.parse(references.stdout).serverId,
		);
		expect(
			(await fetch(`${origin}/execute`, { method: "POST", body: "{}" })).status,
		).toBe(401);
		expect(
			(
				await fetch(`${origin}/execute`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${first.token}`,
						origin: "https://untrusted.example",
					},
					body: "{}",
				})
			).status,
		).toBe(403);
		const absent = await invoke("console.log('ok');", {});
		expect(absent.stdout).toBe("ok\n");
	} finally {
		await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				LANGUAGE_INTELLIGENCE_SOURCE,
				packages,
				JSON.stringify({
					cwd: packages,
					path: "fixture.ts",
					onlyIfWarm: true,
					shutdown: true,
				}),
			],
			{ timeout: 10000 },
		).catch(() => {});
		if (pid)
			try {
				process.kill(-pid, "SIGTERM");
			} catch {}
		await rm(packages, { recursive: true, force: true });
	}
}, 30000);

it("names the failing stage and cause without leaking the bearer token", async () => {
	const { persistentGuestCapabilityRunner } = await import(
		"./persistent-guest-capability"
	);
	const machines = {
		exec: async () => ({
			exitCode: 0,
			stdout: JSON.stringify({ port: 4000, token: "a".repeat(64) }),
			stderr: "",
		}),
	} as unknown as WorkspaceMachines;
	const run = persistentGuestCapabilityRunner(machines, async () => {
		throw new TypeError("fetch failed: Bearer secret-token");
	});
	await expect(
		run(
			WorkspaceId("vm"),
			{ capability: "browser", source: "", arguments: {} },
			new AbortController().signal,
		),
	).rejects.toThrow(
		"Guest service request failed at start (TypeError: fetch failed: Bearer [redacted])",
	);
});
