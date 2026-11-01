/**
 * Local-only check: runs the local-session readers over this machine's real sessions
 * (~/.claude, ~/.codex, OpenCode, Pi, Grok) and prints counts and timings only — never
 * transcript text, paths or titles. Not a test; writes nothing.
 *
 *   node --import tsx scripts/local-sessions-check.ts [repo path for the discovery timing]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
	type AgentTool,
	claudeProjectsDirectory,
	claudeSessionRefForFile,
	codexSessionRefForFile,
	codexSessionsDirectory,
	exportFullTranscript,
	findLatestSession,
	grokSessionRefForDirectory,
	grokSessionsDirectory,
	type LocalSession,
	listCodexRolloutFiles,
	listOpencodeSessionRefs,
	piSessionRefForFile,
	piSessionsDirectory,
	readSession,
	readSessionActivity,
	type SessionRef,
	trimToBudget,
} from "../src/local-sessions/index.ts";

const HANDOFF_BUDGET_CHARS = 200_000;

interface Tally {
	sessions: number;
	turns: number;
	toolCalls: number;
	shellCalls: number;
	exitCodes: number;
	errors: number;
	unparsedRecords: number;
	compactionSummaries: number;
	readFailures: number;
	noMetadata: number;
}

function emptyTally(): Tally {
	return {
		sessions: 0,
		turns: 0,
		toolCalls: 0,
		shellCalls: 0,
		exitCodes: 0,
		errors: 0,
		unparsedRecords: 0,
		compactionSummaries: 0,
		readFailures: 0,
		noMetadata: 0,
	};
}

function jsonlFilesIn(directory: string, depth: number): string[] {
	const files: string[] = [];
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
		else if (entry.isDirectory() && depth > 0)
			files.push(...jsonlFilesIn(full, depth - 1));
	}
	return files;
}

function subdirectories(directory: string): string[] {
	try {
		return fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(directory, entry.name));
	} catch {
		return [];
	}
}

/** Every session on disk per tool; `undefined` entries are files with no readable metadata. */
function allSessionRefs(): Record<AgentTool, (SessionRef | undefined)[]> {
	const claudeFiles = subdirectories(claudeProjectsDirectory()).flatMap(
		(directory) => jsonlFilesIn(directory, 0),
	);
	const grokDirectories = subdirectories(grokSessionsDirectory()).flatMap(
		subdirectories,
	);
	return {
		claude: claudeFiles.map((file) => claudeSessionRefForFile(file)),
		codex: listCodexRolloutFiles(codexSessionsDirectory()).map(
			({ file, mtime }) => codexSessionRefForFile(file, mtime),
		),
		opencode: listOpencodeSessionRefs(),
		pi: jsonlFilesIn(piSessionsDirectory(), 1).map((file) =>
			piSessionRefForFile(file),
		),
		grok: grokDirectories.map((directory) =>
			grokSessionRefForDirectory(directory),
		),
	};
}

function versionBucket(session: LocalSession): string {
	const version = session.cliVersion;
	if (!version) return "unknown";
	const [major, minor] = version.split(".");
	return minor === undefined ? version : `${major}.${minor}`;
}

function addSession(tally: Tally, session: LocalSession): void {
	tally.sessions++;
	tally.turns += session.turns.length;
	tally.unparsedRecords += session.unparsedRecords;
	for (const turn of session.turns) {
		if (turn.synthetic === "compaction-summary") tally.compactionSummaries++;
		for (const call of turn.toolCalls) {
			tally.toolCalls++;
			if (call.kind === "shell") tally.shellCalls++;
			if (call.exitCode !== undefined) tally.exitCodes++;
			if (call.isError) tally.errors++;
		}
	}
}

function printTallies(byKey: Map<string, Tally>): void {
	const rows = [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b));
	console.log(
		[
			"tool@version",
			"sessions",
			"turns",
			"toolCalls",
			"shell",
			"exitCodes",
			"isError",
			"compactions",
			"unparsed",
			"noMeta",
			"readFail",
		].join("\t"),
	);
	for (const [key, tally] of rows) {
		console.log(
			[
				key,
				tally.sessions,
				tally.turns,
				tally.toolCalls,
				tally.shellCalls,
				tally.exitCodes,
				tally.errors,
				tally.compactionSummaries,
				tally.unparsedRecords,
				tally.noMetadata,
				tally.readFailures,
			].join("\t"),
		);
	}
}

function timeMs<T>(run: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = run();
	return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

function largestClaudeTranscript(): SessionRef | undefined {
	let largest: { file: string; size: number } | undefined;
	for (const directory of subdirectories(claudeProjectsDirectory())) {
		for (const file of jsonlFilesIn(directory, 0)) {
			const size = fs.statSync(file).size;
			if (!largest || size > largest.size) largest = { file, size };
		}
	}
	return largest ? claudeSessionRefForFile(largest.file) : undefined;
}

function main(): void {
	const byKey = new Map<string, Tally>();
	const tallyFor = (key: string) => {
		let tally = byKey.get(key);
		if (!tally) {
			tally = emptyTally();
			byKey.set(key, tally);
		}
		return tally;
	};
	for (const [tool, refs] of Object.entries(allSessionRefs())) {
		for (const ref of refs) {
			if (!ref) {
				tallyFor(`${tool}@no-metadata`).noMetadata++;
				continue;
			}
			try {
				const session = readSession(ref);
				addSession(tallyFor(`${tool}@${versionBucket(session)}`), session);
			} catch {
				tallyFor(`${tool}@read-failed`).readFailures++;
			}
		}
	}
	printTallies(byKey);

	const repoPath = process.argv[2] ?? process.cwd();
	const discovery = timeMs(() => findLatestSession(repoPath));
	console.log(
		`\ndiscovery (findLatestSession): ${discovery.ms} ms, found=${discovery.value?.tool ?? "none"}`,
	);

	const largest = largestClaudeTranscript();
	if (!largest) return;
	const sizeMb = Math.round(fs.statSync(largest.location).size / 1024 / 1024);
	const handoff = timeMs(() =>
		trimToBudget(
			readSession(largest, { budgetChars: HANDOFF_BUDGET_CHARS }).turns,
			HANDOFF_BUDGET_CHARS,
		),
	);
	const handoffChars = handoff.value.reduce(
		(sum, turn) => sum + turn.text.length,
		0,
	);
	console.log(
		`tail handoff (${HANDOFF_BUDGET_CHARS} chars) on largest Claude transcript (${sizeMb} MB): ${handoff.ms} ms, turns=${handoff.value.length}, textChars=${handoffChars}`,
	);
	const activity = timeMs(() => readSessionActivity(largest));
	console.log(
		`full activity pass (commands + files) on the same transcript: ${activity.ms} ms, toolCalls=${activity.value.toolCallCount}, commands=${activity.value.successfulCommands.length}, edited=${activity.value.files.edited.length}, written=${activity.value.files.written.length}, read=${activity.value.files.read.length}`,
	);
	const fullRead = timeMs(() => readSession(largest));
	console.log(
		`full conversation read (no budget), for reference: ${fullRead.ms} ms, turns=${fullRead.value.turns.length}`,
	);

	const exportDirectory = fs.mkdtempSync(
		path.join(os.tmpdir(), "local-sessions-export-"),
	);
	try {
		const exported = timeMs(() =>
			exportFullTranscript(largest, {
				outputFile: path.join(exportDirectory, "transcript.md"),
			}),
		);
		const imageBytes = exported.value.images.reduce(
			(sum, image) => sum + fs.statSync(path.join(exportDirectory, image)).size,
			0,
		);
		console.log(
			`full transcript export on the same transcript: ${exported.ms} ms, markdown=${(exported.value.bytesWritten / 1024 / 1024).toFixed(1)} MB, sections=${exported.value.sections}, toolCalls=${exported.value.toolCalls}, images=${exported.value.images.length} (${(imageBytes / 1024 / 1024).toFixed(1)} MB)`,
		);
		for (const [tool, refs] of Object.entries(allSessionRefs())) {
			const newest = refs
				.filter((ref): ref is SessionRef => ref !== undefined)
				.sort((a, b) => b.updatedAt - a.updatedAt)[0];
			if (!newest) continue;
			const result = timeMs(() =>
				exportFullTranscript(newest, {
					outputFile: path.join(exportDirectory, `${tool}.md`),
				}),
			);
			console.log(
				`export newest ${tool}: ${result.ms} ms, markdown=${(result.value.bytesWritten / 1024).toFixed(0)} KB, sections=${result.value.sections}, toolCalls=${result.value.toolCalls}, images=${result.value.images.length}`,
			);
		}
	} finally {
		fs.rmSync(exportDirectory, { recursive: true, force: true });
	}
}

main();
