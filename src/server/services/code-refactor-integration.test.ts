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
it("moves a source file with semantic import updates and applies a real organize-imports action", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "yt-refactor-"));
	const machines = {
		exec: async (_: string, command: string) => {
			if (command.includes('"onlyIfWarm":true'))
				return { exitCode: 0, stdout: '{"available":false}', stderr: "" };
			if (command.includes("node --input-type=module -e"))
				command = command
					.slice(command.indexOf("node --input-type=module -e"))
					.replaceAll(
						/\/tmp\/ytimesy-capability-language-[a-f0-9]+/g,
						process.cwd(),
					);
			try {
				const result = await run("bash", ["-c", command], {
					timeout: 45000,
					maxBuffer: 512000,
				});
				return { exitCode: 0, ...result };
			} catch (error) {
				const result = error as {
					code: number;
					stdout: string;
					stderr: string;
				};
				return {
					exitCode: result.code,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			}
		},
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
		once: async (_, work) => work(),
	});
	const languages = apiAgentLanguageTools(input);
	const invoke = async (tool: unknown, args: object) =>
		(
			tool as { execute: (args: object, options: object) => Promise<unknown> }
		).execute(args, { toolCallId: "refactor", messages: [] });
	try {
		await writeFile(
			join(cwd, "tsconfig.json"),
			'{"compilerOptions":{"strict":true,"module":"commonjs"},"include":["*.ts"]}',
		);
		await writeFile(join(cwd, "index.ts"), "export const answer = 42;\n");
		await writeFile(join(cwd, "a.ts"), "export const a = 1;\n");
		await writeFile(join(cwd, "z.ts"), "export const z = 2;\n");
		await writeFile(
			join(cwd, "usage.ts"),
			'import { z } from "./z";\nimport { answer } from "./index";\nimport { a } from "./a";\nconsole.log(answer, a, z);\n',
		);
		const receipt = (await invoke(tools.rename_file, {
			path: "index.ts",
			newPath: "moved.ts",
		})) as { failedPath: null; completed: { path: string }[] };
		expect(receipt.failedPath).toBeNull();
		expect(receipt.completed.map((file) => file.path)).toContain("moved.ts");
		await expect(readFile(join(cwd, "index.ts"))).rejects.toThrow();
		expect(await readFile(join(cwd, "moved.ts"), "utf8")).toBe(
			"export const answer = 42;\n",
		);
		expect(await readFile(join(cwd, "usage.ts"), "utf8")).toContain(
			'"./moved"',
		);
		await expect(
			invoke(tools.rename_file, { path: "a.ts", newPath: "z.ts" }),
		).rejects.toThrow();
		const selection = {
			path: "usage.ts",
			line: 1,
			column: 1,
			kind: "source.organizeImports",
		};
		const available = (await invoke(languages.inspect_code, {
			...selection,
			operation: "code_actions",
		})) as { result: { index: number; sha256: string; title: string }[] };
		expect(available.result.length).toBeGreaterThan(0);
		const action = available.result[0];
		await expect(
			invoke(tools.apply_code_action, {
				...selection,
				actionIndex: action.index,
				actionSha256: "0".repeat(64),
			}),
		).rejects.toThrow("Code action changed");
		const applied = (await invoke(tools.apply_code_action, {
			...selection,
			actionIndex: action.index,
			actionSha256: action.sha256,
		})) as { failedPath: null };
		expect(applied.failedPath).toBeNull();
		const content = await readFile(join(cwd, "usage.ts"), "utf8");
		expect(content.indexOf('"./a"')).toBeLessThan(content.indexOf('"./moved"'));
		expect(content.indexOf('"./moved"')).toBeLessThan(content.indexOf('"./z"'));
		const readonly = apiAgentFileTools({
			...input,
			readOnly: true,
			once: async (_, work) => work(),
		});
		expect(readonly.rename_file).toBeUndefined();
		expect(readonly.apply_code_action).toBeUndefined();
	} finally {
		await run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				LANGUAGE_INTELLIGENCE_SOURCE,
				process.cwd(),
				JSON.stringify({
					cwd,
					path: "usage.ts",
					onlyIfWarm: true,
					shutdown: true,
				}),
			],
			{ timeout: 10000 },
		).catch(() => {});
		await rm(cwd, { recursive: true, force: true });
	}
}, 60000);
