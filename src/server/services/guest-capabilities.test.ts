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
	try {
		await writeFile(file, original);
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { strict: true } }),
		);
		const invoke = async (operation: string, extra = {}) => {
			const output = await run(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					LANGUAGE_INTELLIGENCE_SOURCE,
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
		expect(JSON.stringify(rename.result)).toContain('"newText":"renamed"');
		expect(await readFile(file, "utf8")).toBe(original);
		await expect(
			invoke("definition", { path: "../outside.ts" }),
		).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);
