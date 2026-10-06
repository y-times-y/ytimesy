import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { apiAgentFileTools } from "./api-agent-file-tools";
import { apiAgentLanguageTools } from "./api-agent-language-tools";
import { LANGUAGE_INTELLIGENCE_SOURCE } from "./language-intelligence";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
it("renames real TypeScript references across files, replays receipts, preflights stale sources and batches two queries in one VM call", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "yt-rename-integration-"));
	const index = "export const answer = 42;\r\n";
	const usage = 'import { answer } from "./index";\r\nconsole.log(answer);\r\n';
	const receipts = new Map<string, unknown>();
	let calls = 0,
		stale = false;
	const execute = async (command: string) => {
		calls++;
		if (command.includes('"onlyIfWarm":true'))
			return { exitCode: 0, stdout: '{"available":false}', stderr: "" };
		if (command.includes("node --input-type=module -e")) {
			command = command.slice(command.indexOf("node --input-type=module -e"));
			command = command.replaceAll(
				/\/tmp\/ytimesy-capability-language-[a-f0-9]+/g,
				process.cwd(),
			);
		}
		if (stale && command.startsWith("python3 -c")) {
			stale = false;
			await writeFile(join(cwd, "usage.ts"), `${usage}// external change\n`);
		}
		try {
			const result = await run("bash", ["-c", command], {
				maxBuffer: 512000,
				timeout: 45000,
			});
			return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const result = error as { code: number; stdout: string; stderr: string };
			return {
				exitCode: result.code,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		}
	};
	const machines = {
		exec: async (_: string, command: string) => execute(command),
		writeTextFile: async (_: string, path: string, body: string) =>
			writeFile(path, body),
	} as unknown as WorkspaceMachines;
	const input = {
		machines,
		vm: WorkspaceId("fixture"),
		cwd,
		signal: new AbortController().signal,
	};
	const tools = apiAgentFileTools({
		...input,
		readOnly: false,
		once: async (id, work) => {
			if (receipts.has(id)) return receipts.get(id);
			const receipt = await work();
			receipts.set(id, receipt);
			return receipt;
		},
	});
	const invoke = async (tool: unknown, args: object, id: string) =>
		(
			tool as { execute: (args: object, options: object) => Promise<unknown> }
		).execute(args, { toolCallId: id, messages: [] });
	const stop = async () =>
		run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				LANGUAGE_INTELLIGENCE_SOURCE,
				process.cwd(),
				JSON.stringify({
					cwd,
					path: "index.ts",
					onlyIfWarm: true,
					shutdown: true,
				}),
			],
			{ timeout: 10000 },
		);
	try {
		await writeFile(
			join(cwd, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { strict: true, module: "commonjs" },
				files: ["index.ts", "usage.ts"],
			}),
		);
		await writeFile(join(cwd, "index.ts"), index);
		await writeFile(join(cwd, "usage.ts"), usage);
		const languages = apiAgentLanguageTools(input);
		const before = calls;
		const batch = (await invoke(
			languages.inspect_code_batch,
			{
				requests: [
					{ path: "index.ts", operation: "references", line: 1, column: 14 },
					{ path: "index.ts", operation: "hover", line: 1, column: 14 },
				],
			},
			"batch",
		)) as { results: { serverId: number; result: unknown }[] };
		expect(calls - before).toBe(1);
		expect(batch.results[0].serverId).toBe(batch.results[1].serverId);
		expect(batch.results[0].result).toHaveLength(3);
		const request = {
			path: "index.ts",
			line: 1,
			column: 14,
			newName: "renamed",
		};
		const receipt = (await invoke(tools.rename_symbol, request, "rename")) as {
			completed: { path: string }[];
			failedPath: null;
		};
		expect(receipt.completed.map((file) => file.path).sort()).toEqual([
			"index.ts",
			"usage.ts",
		]);
		expect(receipt.failedPath).toBeNull();
		expect(await readFile(join(cwd, "index.ts"), "utf8")).toBe(
			index.replaceAll("answer", "renamed"),
		);
		expect(await readFile(join(cwd, "usage.ts"), "utf8")).toBe(
			usage.replaceAll("answer", "renamed"),
		);
		const after = calls;
		expect(await invoke(tools.rename_symbol, request, "rename")).toEqual(
			receipt,
		);
		expect(calls).toBe(after);
		await stop();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await writeFile(join(cwd, "index.ts"), index);
		await writeFile(join(cwd, "usage.ts"), usage);
		stale = true;
		await expect(invoke(tools.rename_symbol, request, "stale")).rejects.toThrow(
			"changed since inspection",
		);
		expect(await readFile(join(cwd, "index.ts"), "utf8")).toBe(index);
		expect(await readFile(join(cwd, "usage.ts"), "utf8")).toBe(
			`${usage}// external change\n`,
		);
		expect(
			apiAgentFileTools({
				...input,
				readOnly: true,
				once: async (_, run) => run(),
			}).rename_symbol,
		).toBeUndefined();
		const prior = calls;
		await expect(
			invoke(
				languages.inspect_code_batch,
				{
					requests: [
						{ path: "index.ts", operation: "hover", line: 1, column: 1 },
						{ path: "other.py", operation: "hover", line: 1, column: 1 },
					],
				},
				"invalid",
			),
		).rejects.toThrow("one supported language");
		expect(calls).toBe(prior);
	} finally {
		await stop().catch(() => {});
		await rm(cwd, { recursive: true, force: true });
	}
}, 60000);
