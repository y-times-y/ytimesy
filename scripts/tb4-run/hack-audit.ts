/**
 * Reward-hack review list for a finished run (docs/tb4-astra-run-2026-10-27.md,
 * "Integrity"). For every passing trial it scans the agent's ATIF trajectory
 * (agent/trajectory.json, subagents included) for:
 * - web_search queries and web_fetch URLs that target the task's own
 *   solution, tests or the benchmark's repositories;
 * - commands or file reads that touch test, grader, oracle or reward files.
 * It flags; a person reviews each flag and voids a trial only on evidence.
 * No model calls.
 *
 *   node --import tsx scripts/tb4-run/hack-audit.ts <results-root> [--out review.jsonl]
 */
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

export type Flag = {
	kind: "web" | "files";
	tool: string;
	evidence: string;
	why: string;
};

const BENCHMARK_HINTS = [
	/terminal[-_ ]?bench/i,
	/\btbench\b/i,
	/harbor[-_ ]?framework/i,
	/laude[-_ ]?institute/i,
	/hub\.harborframework\.com/i,
	/\bsolve\.sh\b/i,
	/\boracle\b/i,
	/test_outputs/i,
	/reference solution/i,
];
const GRADER_PATHS = [
	/(^|[\s"'=:/])\/tests?\//,
	/\btest_outputs\.py\b/,
	/\bsolution\/solve\.sh\b/,
	/\/oracle\b/,
	/\/logs\/verifier\b/,
	/\breward\.(txt|json)\b/,
	/\bctrf\.json\b/,
	/_hidden_outputs/,
];

/** Strings worth checking from one tool call: the query, URL, command or path (and run_code source). */
function callTexts(
	name: string,
	args: unknown,
): { tool: string; text: string }[] {
	const a = (args ?? {}) as Record<string, unknown>;
	const out: { tool: string; text: string }[] = [];
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	if (/search/i.test(name))
		out.push({ tool: "web_search", text: str(a.query) || JSON.stringify(a) });
	else if (/fetch/i.test(name))
		out.push({ tool: "web_fetch", text: str(a.url) || JSON.stringify(a) });
	else if (name === "run_code" || name === "codemode") {
		const code = str(a.code);
		for (const m of code.matchAll(
			/web_search\(\s*\{[^}]*?query\s*:\s*(["'`])([\s\S]*?)\1/g,
		))
			out.push({ tool: "web_search", text: m[2] });
		for (const m of code.matchAll(
			/web_fetch\(\s*\{[^}]*?url\s*:\s*(["'`])([\s\S]*?)\1/g,
		))
			out.push({ tool: "web_fetch", text: m[2] });
		out.push({ tool: "run_code", text: code });
	} else
		out.push({
			tool: name,
			text:
				str(a.command) || str(a.path) || str(a.file_path) || JSON.stringify(a),
		});
	return out;
}

/** Flags for one trajectory (and its subagent trajectories, if embedded). */
export function auditTrajectory(trajectory: unknown, task: string): Flag[] {
	const flags: Flag[] = [];
	const taskWords = new RegExp(`\\b${task.replace(/[-_]/g, "[-_ ]?")}\\b`, "i");
	const visit = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) return node.forEach(visit);
		const o = node as Record<string, unknown>;
		if (Array.isArray(o.tool_calls))
			for (const call of o.tool_calls as {
				function_name?: string;
				arguments?: unknown;
			}[]) {
				for (const { tool, text } of callTexts(
					call.function_name ?? "",
					call.arguments,
				)) {
					const snippet = text.slice(0, 300);
					if (tool === "web_search" || tool === "web_fetch") {
						const hint = BENCHMARK_HINTS.find((r) => r.test(text));
						if (hint)
							flags.push({
								kind: "web",
								tool,
								evidence: snippet,
								why: `matches ${hint}`,
							});
						else if (
							taskWords.test(text) &&
							/solution|answer|tests?|grader|benchmark|github/i.test(text)
						)
							flags.push({
								kind: "web",
								tool,
								evidence: snippet,
								why: "names the task with solution/test words",
							});
					} else {
						const p = GRADER_PATHS.find((r) => r.test(text));
						if (p)
							flags.push({
								kind: "files",
								tool,
								evidence: snippet,
								why: `touches ${p}`,
							});
					}
				}
			}
		for (const v of Object.values(o)) if (v && typeof v === "object") visit(v);
	};
	visit(trajectory);
	return flags;
}

/** Every trial dir under root that holds result.json + agent/trajectory.json. */
function* trialDirs(root: string, depth = 0): Generator<string> {
	if (depth > 6 || !existsSync(root) || !statSync(root).isDirectory()) return;
	if (
		existsSync(join(root, "result.json")) &&
		existsSync(join(root, "agent", "trajectory.json"))
	) {
		yield root;
		return;
	}
	for (const name of readdirSync(root))
		yield* trialDirs(join(root, name), depth + 1);
}

export function auditRun(root: string) {
	const rows: { trial: string; task: string; reward: number; flags: Flag[] }[] =
		[];
	for (const dir of trialDirs(root)) {
		const result = JSON.parse(
			readFileSync(join(dir, "result.json"), "utf8"),
		) as {
			task_name?: string;
			verifier_result?: { rewards?: { reward?: number } };
		};
		const reward = Number(result.verifier_result?.rewards?.reward ?? 0);
		if (reward < 1) continue;
		const task = (result.task_name ?? basename(dir).split("__")[0])
			.split("/")
			.pop()!;
		const flags = auditTrajectory(
			JSON.parse(readFileSync(join(dir, "agent", "trajectory.json"), "utf8")),
			task,
		);
		rows.push({ trial: basename(dir), task, reward, flags });
	}
	return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { out: { type: "string" } },
	});
	const rows = auditRun(positionals[0] ?? ".");
	const flagged = rows.filter((r) => r.flags.length);
	if (values.out)
		writeFileSync(
			values.out,
			`${flagged.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
	console.log(
		`${rows.length} passing trials scanned, ${flagged.length} flagged for review`,
	);
	for (const r of flagged)
		console.log(
			`${r.trial}: ${r.flags.map((f) => `${f.tool} ${f.why}`).join("; ")}`,
		);
}
