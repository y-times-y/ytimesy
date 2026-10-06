import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { STRUCTURED_CODE_READ_SOURCE } from "./structured-code-reads";

const run = promisify(execFile);
it("reads outlines and exact CRLF/Unicode ranges in one process, fences stale reads and rejects escapes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "yt-code-outline-"));
	const invoke = async (files: object[]) =>
		JSON.parse(
			(
				await run(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						STRUCTURED_CODE_READ_SOURCE,
						process.cwd(),
						JSON.stringify({ cwd, files }),
					],
					{ maxBuffer: 256000 },
				)
			).stdout,
		);
	try {
		const source =
			'export function greet(name: string) {\r\n  return "hello 😀" + name;\r\n}\r\nexport class Service {\r\n  run() { return greet("you"); }\r\n}\r\n';
		await writeFile(join(cwd, "index.ts"), source);
		await writeFile(join(cwd, "other.py"), "def greet():\n    return 1\n");
		const outline = (
			await invoke([
				{ path: "index.ts", view: "outline" },
				{ path: "other.py", view: "outline" },
			])
		).files;
		expect(outline[0].status).toBe("ok");
		expect(
			outline[0].declarations.map((d: { name: string }) => d.name),
		).toEqual(["greet", "Service", "run"]);
		expect(outline[0].declarations[0]).toMatchObject({
			startLine: 1,
			endLine: 3,
		});
		expect(JSON.stringify(outline[0].declarations)).not.toContain("hello");
		expect(outline[1].status).toBe("unsupported");
		const exact = (
			await invoke([
				{
					path: "index.ts",
					view: "lines",
					startLine: 2,
					endLine: 2,
					expectedSha256: outline[0].sha256,
				},
			])
		).files[0];
		expect(exact.content).toBe('  return "hello 😀" + name;\r\n');
		expect(exact.completeFile).toBe(false);
		await writeFile(join(cwd, "index.ts"), `${source}// changed\n`);
		await expect(
			invoke([
				{
					path: "index.ts",
					view: "lines",
					startLine: 1,
					endLine: 1,
					expectedSha256: outline[0].sha256,
				},
			]),
		).rejects.toThrow("changed");
		await symlink(process.cwd(), join(cwd, "escape"));
		await expect(
			invoke([{ path: "escape/package.json", view: "outline" }]),
		).rejects.toThrow("escapes");
		await expect(
			invoke([{ path: "../package.json", view: "outline" }]),
		).rejects.toThrow("Invalid repository path");
		await writeFile(join(cwd, "broken.ts"), "export function broken( {");
		expect(
			(await invoke([{ path: "broken.ts", view: "outline" }])).files[0].status,
		).toBe("syntax_errors");
		await writeFile(
			join(cwd, "large.ts"),
			`export const value = '${"x".repeat(61000)}';`,
		);
		await expect(
			invoke([{ path: "large.ts", view: "lines", startLine: 1, endLine: 1 }]),
		).rejects.toThrow("batch limit");
		await writeFile(
			join(cwd, "many.ts"),
			Array.from({ length: 205 }, (_, i) => `export const v${i} = ${i};`).join(
				"\n",
			),
		);
		const many = (await invoke([{ path: "many.ts", view: "outline" }]))
			.files[0];
		expect(many.truncated).toBe(true);
		expect(many.omittedDeclarations).toBe(5);
		await writeFile(join(cwd, "bom.txt"), "\uFEFFfirst\r\nsecond\r\n");
		expect(
			(
				await invoke([
					{ path: "bom.txt", view: "lines", startLine: 1, endLine: 1 },
				])
			).files[0].content,
		).toBe("\uFEFFfirst\r\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}, 30000);
