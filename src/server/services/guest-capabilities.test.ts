import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { guestCapabilityCommand } from "./guest-node-capability";
import {
	LANGUAGE_INTELLIGENCE_SOURCE,
	languageQueryResult,
} from "./language-intelligence";

const run = promisify(execFile);

it("installs exact tooling outside the repository without package lifecycle scripts", () => {
	const command = guestCapabilityCommand("browser", "console.log('{}')", {
		url: "a'; touch /tmp/unwanted",
	});
	expect(command).toContain("playwright-core@1.63.0");
	expect(command).toContain("--ignore-scripts");
	expect(command).toContain("flock -w 120");
	expect(command).toContain("timeout --kill-after=5s 55s");
	expect(command).toContain("a'\\''; touch");
});

it("asks a real TypeScript language server for references and a rename without editing files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-language-fixture-"));
	const file = join(directory, "index.ts");
	const original = "export const answer = 42;\nconsole.log(answer);\n";
	const stop = () =>
		run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				LANGUAGE_INTELLIGENCE_SOURCE,
				process.cwd(),
				JSON.stringify({
					cwd: directory,
					path: "index.ts",
					onlyIfWarm: true,
					shutdown: true,
				}),
			],
			{ timeout: 10000 },
		);
	try {
		await writeFile(file, original);
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }),
		);
		const delayedServer = join(directory, "delayed-server.mjs");
		await writeFile(
			delayedServer,
			`import {spawn} from 'node:child_process';
setTimeout(() => {
 const child=spawn(${JSON.stringify(join(process.cwd(), "node_modules/.bin/typescript-language-server"))}, process.argv.slice(2), {stdio:'inherit'});
 child.on('exit', code => {process.exitCode=code ?? 1;});
}, 3000);`,
		);
		const invoke = async (operation: string, extra = {}) => {
			// Reproduce a cold server that cannot possibly publish within 2.5s.
			const source =
				operation === "diagnostics"
					? LANGUAGE_INTELLIGENCE_SOURCE.replace(
							"const [command, ...args] = commands[language];",
							`const command=process.execPath, args=[${JSON.stringify(delayedServer)}, '--stdio'];`,
						)
					: LANGUAGE_INTELLIGENCE_SOURCE;
			const output = await run(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					source,
					process.cwd(),
					JSON.stringify({
						cwd: directory,
						path: "index.ts",
						operation,
						line: 1,
						column: 14,
						...extra,
					}),
				],
				{ timeout: 45000, maxBuffer: 256000 },
			);
			return languageQueryResult.parse(JSON.parse(output.stdout));
		};
		const references = await invoke("references");
		expect(references.language).toBe("typescript");
		expect(references.result).toHaveLength(2);
		const rename = await invoke("rename_preview", { newName: "renamed" });
		expect(rename.serverId).toBe(references.serverId);
		expect(JSON.stringify(rename.result)).toContain('"newText":"renamed"');
		expect(await readFile(file, "utf8")).toBe(original);
		await writeFile(file, 'export const answer: number = "wrong";\n');
		const diagnostics = await invoke("diagnostics");
		expect(diagnostics.serverId).toBe(references.serverId);
		expect(diagnostics.diagnosticsObserved).toBe(true);
		expect(JSON.stringify(diagnostics.result)).toContain('"code":2322');
		await stop();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const coldDiagnostics = await invoke("diagnostics");
		expect(coldDiagnostics.serverId).not.toBe(references.serverId);
		expect(JSON.stringify(coldDiagnostics.result)).toContain('"code":2322');
		await expect(
			invoke("definition", { path: "../outside.ts" }),
		).rejects.toThrow();
	} finally {
		await stop().catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);
