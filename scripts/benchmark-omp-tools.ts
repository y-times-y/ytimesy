import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

// Extract the exact committed guest program; never run a sibling checkout.
const run = promisify(execFile);
const dependencyRoot = resolve(".ytimesy/perf/runtime");
async function committedRawSource(revision: string, path: string) {
	const source = (await run("git", ["show", `${revision}:${path}`])).stdout;
	const start = source.indexOf("String.raw`");
	if (start < 0) throw new Error("Committed guest source was not found");
	return source.slice(start + 11, source.lastIndexOf("`"));
}
const after = await committedRawSource(
	"6136eec",
	"src/server/services/warm-language-intelligence.ts",
);
const STRUCTURED_CODE_READ_SOURCE = await committedRawSource(
	"6136eec",
	"src/server/services/structured-code-reads.ts",
);
const baseline = (
	await run("git", [
		"show",
		"d998928:src/server/services/warm-language-intelligence.ts",
	])
).stdout;
const before = baseline.slice(
	baseline.indexOf("String.raw`") + 11,
	baseline.lastIndexOf("`"),
);
const baselineFiles = (
	await run("git", [
		"show",
		"d998928:src/server/services/api-agent-file-tools.ts",
	])
).stdout;
const readMarker = "const READ_FILES_SCRIPT = `";
const readStart = baselineFiles.indexOf(readMarker) + readMarker.length;
const baselineRead = baselineFiles.slice(
	readStart,
	baselineFiles.indexOf("`;", readStart),
);
const observations: object[] = [];
const requests = [
	{ path: "index.ts", operation: "references", line: 1, column: 14 },
	{ path: "index.ts", operation: "hover", line: 1, column: 14 },
];
async function invoke(source: string, input: object) {
	const started = performance.now();
	const output = await run(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			source,
			dependencyRoot,
			JSON.stringify(input),
		],
		{ timeout: 45000, maxBuffer: 1000000 },
	);
	return { ms: performance.now() - started, result: JSON.parse(output.stdout) };
}
for (let repetition = 0; repetition < 8; repetition++) {
	for (const arm of repetition % 2
		? ["after", "before"]
		: ["before", "after"]) {
		const cwd = await mkdtemp(join(tmpdir(), "yt-omp-perf-"));
		const source = arm === "before" ? before : after;
		try {
			await writeFile(join(cwd, "index.ts"), "export const answer = 42;\n");
			await writeFile(
				join(cwd, "usage.ts"),
				'import { answer } from "./index";\nconsole.log(answer);\n',
			);
			await writeFile(
				join(cwd, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: { strict: true, module: "commonjs" },
					files: ["index.ts", "usage.ts"],
				}),
			);
			const cold = await invoke(source, { cwd, ...requests[0] });
			observations.push({
				repetition,
				arm,
				kind: "cold_references",
				ms: cold.ms,
				referenceCount: cold.result.result.length,
			});
			for (let sample = 0; sample < 3; sample++) {
				const sequential = async () => {
					const first = await invoke(source, { cwd, ...requests[0] });
					const second = await invoke(source, { cwd, ...requests[1] });
					return {
						ms: first.ms + second.ms,
						referenceCount: first.result.result.length,
						hoverPresent: Boolean(second.result.result),
					};
				};
				const recordSequential = async () =>
					observations.push({
						repetition,
						sample,
						arm,
						kind: "warm_sequential",
						...(await sequential()),
					});
				const recordBatch = async () => {
					const batch = await invoke(source, {
						cwd,
						path: "index.ts",
						requests,
					});
					observations.push({
						repetition,
						sample,
						arm,
						kind: "warm_batch",
						ms: batch.ms,
						referenceCount: batch.result.results[0].result.length,
						hoverPresent: Boolean(batch.result.results[1].result),
					});
				};
				// Alternate query order to avoid systematically favoring the later sample.
				if (arm === "after" && sample % 2 === repetition % 2) {
					await recordBatch();
					await recordSequential();
				} else {
					await recordSequential();
					if (arm === "after") await recordBatch();
				}
			}
		} finally {
			await invoke(source, {
				cwd,
				path: "index.ts",
				onlyIfWarm: true,
				shutdown: true,
			}).catch(() => {});
			await rm(cwd, { recursive: true, force: true });
		}
	}
	process.stdout.write(`Completed paired repetition ${repetition + 1}/8\n`);
}
const cwd = await mkdtemp(join(tmpdir(), "yt-outline-perf-"));
const outlines: object[] = [];
try {
	for (const path of [
		"src/server/services/api-agent-file-tools.ts",
		"src/server/services/model-agent-loop.ts",
		"src/server/services/warm-language-intelligence.ts",
	]) {
		const content = (await run("git", ["show", `6136eec:${path}`])).stdout;
		await writeFile(join(cwd, "fixture.ts"), content);
		for (let repetition = 0; repetition < 8; repetition++) {
			const readFull = async () => {
				const started = performance.now();
				const output = await run("python3", [
					"-c",
					baselineRead,
					cwd,
					JSON.stringify(["fixture.ts"]),
					JSON.stringify({ start: null, maxCharacters: 128000 }),
				]);
				const result = JSON.parse(output.stdout);
				if (result[0].truncated || result[0].content !== content)
					throw new Error("Full-read fixture mismatch");
				return {
					ms: performance.now() - started,
					bytes: Buffer.byteLength(JSON.stringify(result)),
				};
			};
			let full = repetition % 2 === 0 ? await readFull() : undefined;
			const outline = await invoke(STRUCTURED_CODE_READ_SOURCE, {
				cwd,
				files: [{ path: "fixture.ts", view: "outline" }],
			});
			full ??= await readFull();
			outlines.push({
				fullReadMs: full.ms,
				fullReadResponseBytes: full.bytes,
				path,
				repetition,
				ms: outline.ms,
				fullSourceBytes: Buffer.byteLength(content),
				outlineResponseBytes: Buffer.byteLength(JSON.stringify(outline.result)),
				status: outline.result.files[0].status,
				declarations: outline.result.files[0].declarations.length,
				truncated: outline.result.files[0].truncated,
			});
		}
	}
} finally {
	await rm(cwd, { recursive: true, force: true });
}
await writeFile(
	".ytimesy/perf/omp-tools.json",
	JSON.stringify(
		{
			baseline: "d998928",
			treatment: "6136eec",
			node: process.version,
			platform: process.platform,
			runtime: {
				typescript: "6.0.2",
				languageServer: "6.0.1",
				jsonrpc: "9.0.3",
			},
			observations,
			outlines,
		},
		null,
		2,
	),
);
