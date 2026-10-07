import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { repositorySearchCommand } from "../src/server/services/indexed-repository-search";

const run = promisify(execFile);
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(16, 32, 64);
if (sizes.some((size) => ![16, 32, 64].includes(size)))
	throw new Error("Supported corpus sizes: 16, 32, 64 MiB.");

// Synthetic code-shaped input measures overhead, not representative agent quality.
for (const mib of sizes) {
	const cwd = await realpath(
		await mkdtemp(join(tmpdir(), "yt-search-benchmark-")),
	);
	const cache = join(
		tmpdir(),
		`ytimesy-search-${process.getuid?.()}-${createHash("sha256").update(cwd).digest("hex")}`,
	);
	try {
		await run("git", ["init", "-q", cwd]);
		await mkdir(join(cwd, "src"));
		const files = mib * 16;
		for (let file = 0; file < files; file++) {
			let body = "";
			for (let line = 0; body.length < 65536; line++) {
				const identifier = createHash("sha256")
					.update(`${file}:${line}`)
					.digest("hex")
					.slice(0, 16);
				body += `export const value_${identifier} = ${line};\n`;
			}
			await writeFile(join(cwd, "src", `${file}.ts`), body.slice(0, 65536));
		}
		const markerFile = join(cwd, "src", "0.ts");
		const marker = "export const rareSearchMarker = true;\n";
		await writeFile(
			markerFile,
			`${marker}${(await readFile(markerFile, "utf8")).slice(marker.length)}`,
		);
		await run("git", ["-C", cwd, "add", "."]);
		const search = async (useIndex: boolean, query: string) => {
			const start = performance.now();
			let output: { stdout: string; stderr: string; code: number };
			try {
				output = {
					...(await run(
						"bash",
						[
							"-lc",
							repositorySearchCommand({
								cwd,
								query,
								path: ".",
								literal: true,
								useIndex,
							}),
						],
						{ maxBuffer: 4 * 1024 * 1024 },
					)),
					code: 0,
				};
			} catch (error) {
				const failure = error as typeof output;
				if (failure.code !== 1) throw error;
				output = failure;
			}
			return { milliseconds: Math.round(performance.now() - start), ...output };
		};
		const samples = [];
		for (const phase of [
			"cold",
			"warm-1",
			"warm-2",
			"warm-3",
			"edited",
			"absent",
		]) {
			if (phase === "edited")
				await writeFile(
					markerFile,
					(await readFile(markerFile, "utf8")).replace(
						"rareSearchMarker = true",
						"rareSearchMarker = null",
					),
				);
			const query =
				phase === "absent" ? "missingSearchMarker" : "rareSearchMarker";
			const native = await search(false, query);
			const indexed = await search(true, query);
			if (
				native.code !== indexed.code ||
				native.stdout !== indexed.stdout ||
				native.stderr !== indexed.stderr
			)
				throw new Error(`Search mismatch at ${mib} MiB, ${phase}`);
			samples.push({
				phase,
				gitMs: native.milliseconds,
				indexMs: indexed.milliseconds,
				identical: true,
			});
		}
		const indexedFiles = await run("python3", [
			"-c",
			"import os,sqlite3,sys; p=sys.argv[1]; c=sqlite3.connect('file:'+p+'?mode=ro',uri=True) if os.path.exists(p) else None; tables=c.execute(\"select name from sqlite_master where name='files'\").fetchall() if c else []; print(c.execute('select count(*) from files').fetchone()[0] if tables else 0)",
			join(cache, "index.sqlite"),
		]);
		console.log(
			JSON.stringify({
				corpusMiB: mib,
				files,
				indexedFiles: Number(indexedFiles.stdout),
				samples,
				limitation:
					"Sequential synthetic local timing, not a Cursor comparison or production benchmark.",
			}),
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(cache, { recursive: true, force: true });
	}
}
