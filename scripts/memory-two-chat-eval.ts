// Does cross-chat memory (Agent Memory Repo) help? Development only.
//
//   node --import tsx scripts/memory-two-chat-eval.ts --dry-run
//       Offline: every scenario verifier passes a rule-following answer and
//       fails a rule-breaking one, and chat 2 never leaks the rule.
//   CLOUDFLARE_API_TOKEN=$(npx wrangler auth token) node --import tsx scripts/memory-two-chat-eval.ts --recall
//       Offline line retrieval with the read hook's embeddings and selection:
//       requests in different words than the saved rule must surface it.
//       CLOUDFLARE_ACCOUNT_ID defaults to scripts/development-config.ts.
//   node --env-file=.env --import tsx scripts/memory-two-chat-eval.ts --live --arms off,spec,full
//       Live two-chat runs on the development edge with the Codex subscription.
//   node --env-file=.env --import tsx scripts/memory-two-chat-eval.ts --live --arms full,supermemory
//       Adds Supermemory's Claude Code plugin as a competitor arm (eval only).
//   node --import tsx scripts/memory-two-chat-eval.ts --sm-recall
//       Offline: Supermemory's own retrieval of each scenario's rule for the
//       final prompt (rank and score), from the setup prompts as conversations.
//
// Arms (live):
//   off   the final chat only, memory off: the baseline.
//   spec  the spec's loop: seeded memory if any, then each setup chat (the
//         builder saves and pushes) followed by one dream, then the final chat.
//   full  spec plus the read hook, the save hook and the extra metadata keys.
//   supermemory  our memory off; Supermemory's plugin replayed instead (see
//         memory-eval/supermemory.ts): each setup chat is captured as a document
//         in a fresh container, the final chat gets the session-start profile and
//         the prompt recall as extra text parts. Their MCP search tools are not
//         offered mid-chat.
// Each (arm, scenario, repeat) runs as its own throwaway eval user
// (scripts/smoke/eval-user.ts) with its own project, memory settings and
// memory repo, so runs never see each other's memory or the owner's, and they
// can run side by side (--concurrency) and alongside other eval processes.
// --variant memoryWording=rules presents recalled memory as binding rules
// (docs/parallel-evals.md).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import {
	harnessVariantFromFlags,
	harnessVariantLabel,
} from "../src/domain/harness-variant";
import {
	cosineSimilarity,
	MEMORY_MATCH_LIMIT,
	MEMORY_MATCH_MIN_SIMILARITY,
	MEMORY_PART_OPEN,
	type MemoryLine,
	memoryLineEmbeddingText,
	memoryToday,
	selectMemoryMatches,
} from "../src/domain/memory-repo";
import {
	CLOUDFLARE_ACCOUNT_ID,
	DEVELOPMENT_EDGE_ORIGIN,
} from "./development-config";
import {
	DISTRACTOR_LINES,
	RECALL_PROBES,
	RULE_FILES,
	SCENARIOS,
	type Scenario,
	setupChats,
} from "./memory-eval/scenarios";
import {
	captureText,
	type ProfileResponse,
	recallContext,
	recalledResults,
	recallQuery,
	sessionStartContext,
	supermemoryApiKey,
	supermemoryClient,
	waitProcessed,
} from "./memory-eval/supermemory";
import {
	assertDevelopmentDatabase,
	createEvalUser,
	type EvalUser,
	MEMORY_NAMESPACE,
	onEvalStop,
	SLOT_LIMITS,
	withSlot,
} from "./smoke/eval-user";

const runCommand = promisify(execFile);

const { values: flags } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		recall: { type: "boolean", default: false },
		"sm-recall": { type: "boolean", default: false },
		/** Seconds to wait for Supermemory to process each captured chat. */
		"sm-wait": { type: "string", default: "900" },
		/** Supermemory processing mode; unset keeps the plugin's (API default, dynamic). */
		"sm-dreaming": { type: "string" },
		live: { type: "boolean", default: false },
		arms: { type: "string", default: "off,spec,full" },
		scenarios: { type: "string" },
		model: { type: "string", default: "gpt-6.1-sol" },
		effort: { type: "string", default: "medium" },
		"turn-timeout": { type: "string", default: "300" },
		"dream-timeout": { type: "string", default: "600" },
		/** USD per million tokens, for the $ columns; omit on a ChatGPT plan. */
		"price-in": { type: "string" },
		"price-out": { type: "string" },
		"keep-repos": { type: "boolean", default: false },
		out: { type: "string" },
		/** Harness variant, e.g. memoryWording=rules (repeatable). */
		variant: { type: "string", multiple: true },
		/** Runs of each (arm, scenario), each as its own eval user. */
		repeat: { type: "string", default: "1" },
		/** Scenario runs at once in this process (eval users make it safe). */
		concurrency: { type: "string", default: "2" },
	},
});

const PROMPT_SUFFIX =
	"\n\nWork directly in this repository: no plan proposal, child tasks, pull requests or publishing, and no commits to this repository. Stop when the change is done and checked.";

const fixtureRepoScript = (dir: string) =>
	`cd '${dir}' && git init -q && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -qm fixture && git update-ref refs/ytimesy/base HEAD`;

const shellCommand = (script: string) =>
	`bash -c '${script.replaceAll("'", "'\\''")}'`;

function selectScenarios() {
	if (!flags.scenarios) return SCENARIOS;
	return flags.scenarios.split(",").map((id) => {
		const scenario = SCENARIOS.find((row) => row.id === id.trim());
		if (!scenario)
			throw new Error(
				`Unknown scenario ${id}; choose from ${SCENARIOS.map((row) => row.id).join(", ")}.`,
			);
		return scenario;
	});
}

function table(rows: string[][]) {
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => row[column].length)),
	);
	return rows
		.map((row) =>
			row.map((cell, column) => cell.padEnd(widths[column])).join("  "),
		)
		.join("\n");
}

// ---------------------------------------------------------------------------
// --dry-run

async function writeFiles(dir: string, files: Record<string, string | null>) {
	for (const [path, content] of Object.entries(files)) {
		const target = join(dir, path);
		if (content === null) {
			await rm(target, { force: true });
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

async function verifyLocally(
	scenario: Scenario,
	solution: Record<string, string | null>,
) {
	const dir = await mkdtemp(join(tmpdir(), `memory-eval-${scenario.id}-`));
	try {
		await writeFiles(dir, scenario.chat2.files);
		await runCommand("bash", ["-c", fixtureRepoScript(dir)]);
		await writeFiles(dir, solution);
		try {
			await runCommand("bash", ["-c", shellCommand(scenario.verify)], {
				cwd: dir,
				timeout: 30_000,
			});
			return true;
		} catch {
			return false;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function dryRun() {
	const rows = [["scenario", "untouched", "follows", "breaks", "no leak"]];
	let ok = true;
	for (const scenario of selectScenarios()) {
		const untouched = await verifyLocally(scenario, {});
		const follows = await verifyLocally(scenario, scenario.solutions.follows);
		const breaks = await verifyLocally(scenario, scenario.solutions.breaks);
		const leaked = [
			scenario.chat2.prompt,
			...(scenario.leakCheck === "prompt"
				? []
				: Object.values(scenario.chat2.files)),
		].some((text) => scenario.leaks.test(text));
		// The rule must reach memory somehow: said or hit in a setup chat, or seeded.
		const rulePresent = [
			...setupChats(scenario).flatMap((chat) => [
				chat.prompt,
				...Object.values(chat.files),
			]),
			...Object.values(scenario.seed ?? {}),
		].some((text) => scenario.leaks.test(text));
		const good = !untouched && follows && !breaks && !leaked && rulePresent;
		ok &&= good;
		rows.push([
			scenario.id,
			untouched ? "PASSES (bad)" : "fails",
			follows ? "passes" : "FAILS (bad)",
			breaks ? "PASSES (bad)" : "fails",
			leaked ? "LEAKS" : rulePresent ? "ok" : "RULE NEVER REACHES MEMORY",
		]);
	}
	console.log(table(rows));
	if (!ok) throw new Error("A scenario or verifier is invalid.");
	// The supermemory arm's replay of the plugin's formatting and filters.
	const turn = captureText(
		[
			{ kind: "userMessage", id: "u", text: "Use pnpm here, never npm." },
			{ kind: "reasoning", id: "r", text: "hidden" },
			{
				kind: "agentMessage",
				id: "a",
				text: "Noted; I will use pnpm from now on.",
			},
			{ kind: "commandExecution", id: "c", command: "pnpm i" },
		] as unknown as Parameters<typeof captureText>[0],
		"2026-01-01T00:00:00Z",
	);
	const kept = recalledResults({
		searchResults: {
			results: [
				{ memory: "a", similarity: 0.9 },
				{ memory: "b", similarity: 0.54 },
				{ chunk: "c" },
				{ memory: " ", similarity: 0.9 },
				...["d", "e", "f", "g"].map((memory) => ({ memory, similarity: 0.6 })),
			],
		},
	});
	const checks = [
		turn?.startsWith("<|turn_start|>2026-01-01T00:00:00Z") &&
			turn.includes("<|start|>assistant<|message|>Noted") &&
			!turn.includes("hidden") &&
			!turn.includes("pnpm i<"),
		captureText([], "2026-01-01T00:00:00Z") === null,
		kept.map((row) => row.memory ?? row.chunk).join("") === "acdef",
		recallQuery("fix it") === null &&
			recallQuery("/compact the conversation") === null,
		recallContext([], "tag") === null,
		sessionStartContext(
			{ profile: { static: ["s1"], dynamic: [] } },
			"tag",
			"fixture",
		).items === 1,
	];
	if (checks.some((check) => !check))
		throw new Error(`Supermemory replay check failed: ${checks.join(",")}`);
	console.log("\nDry run passed.");
}

// ---------------------------------------------------------------------------
// --recall

/**
 * The read hook's selection (selectMemoryMatches) on real embeddings: every
 * scenario rule plus distractors as memory lines; each probe must select
 * its rule.
 */
async function recall() {
	process.env.CLOUDFLARE_ACCOUNT_ID ||= CLOUDFLARE_ACCOUNT_ID;
	const { memoryEmbedder } = await import(
		"../src/server/adapters/memory-embeddings"
	);
	const embed = memoryEmbedder();
	if (!embed)
		throw new Error(
			"Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (npx wrangler auth token).",
		);
	const lines = [
		...SCENARIOS.map((scenario) => ({
			id: scenario.id,
			path: RULE_FILES[scenario.id],
			text: scenario.rule,
		})),
		...DISTRACTOR_LINES.map((line) => ({ id: "distractor", ...line })),
	].map((line, index): MemoryLine & { id: string } => ({
		...line,
		line: index + 1,
		raw: `- ${line.text}`,
		meta: {},
	}));
	const today = memoryToday();
	const vectors = await embed.documents(lines.map(memoryLineEmbeddingText));
	const rows = [
		["probe", "rule", "similarity", "rank", "recalled", "wrong lines injected"],
	];
	let recalled = 0;
	let wrong = 0;
	const similarities: {
		probe: string;
		line: string;
		right: boolean;
		score: number;
	}[] = [];
	for (const probe of RECALL_PROBES) {
		const query = await embed.query(probe.query);
		const scores = new Map(
			lines.map((line, index) => [
				line,
				cosineSimilarity(query, vectors[index]),
			]),
		);
		similarities.push(
			...lines.map((line) => ({
				probe: probe.query,
				line: line.text,
				right: line.id === probe.scenario,
				score: scores.get(line) ?? 0,
			})),
		);
		const ranked = lines
			.map((line) => ({ ...line, score: scores.get(line) ?? 0 }))
			.sort((a, b) => b.score - a.score);
		const rank = ranked.findIndex((line) => line.id === probe.scenario) + 1;
		const hit = ranked[rank - 1];
		// What the read hook would inject for this message, by its own selection.
		const selected = selectMemoryMatches({
			lines,
			scores,
			alreadyShown: () => false,
			today,
			project: null,
		});
		const rule = lines.find((line) => line.id === probe.scenario);
		const ok = Boolean(rule && selected.includes(rule));
		if (ok) recalled++;
		const noise = selected.filter((line) => line !== rule).length;
		wrong += noise;
		rows.push([
			probe.query.slice(0, 60),
			probe.scenario,
			hit.score.toFixed(3),
			String(rank),
			ok ? "yes" : "MISS",
			String(noise),
		]);
	}
	console.log(table(rows));
	console.log(
		`\nRecalled ${recalled}/${RECALL_PROBES.length}; ${wrong} wrong lines injected in total (top ${MEMORY_MATCH_LIMIT}, similarity >= ${MEMORY_MATCH_MIN_SIMILARITY}).`,
	);
	// Threshold data: how right and wrong lines score, and what each cutoff would do.
	const right = similarities.filter((row) => row.right).map((row) => row.score);
	const other = similarities
		.filter((row) => !row.right)
		.map((row) => row.score);
	const stats = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b);
		const at = (q: number) =>
			sorted[
				Math.min(sorted.length - 1, Math.floor(q * sorted.length))
			].toFixed(3);
		return `min ${at(0)} p25 ${at(0.25)} median ${at(0.5)} p75 ${at(0.75)} max ${at(1)}`;
	};
	console.log(`Right lines: ${stats(right)}`);
	console.log(`Other lines: ${stats(other)}`);
	const sweep = [["cutoff", "right lines above", "other lines above"]];
	for (const cutoff of [0.25, 0.3, 0.33, 0.35, 0.4, 0.45, 0.5, 0.55])
		sweep.push([
			cutoff.toFixed(2),
			`${right.filter((score) => score >= cutoff).length}/${right.length}`,
			`${other.filter((score) => score >= cutoff).length}/${other.length}`,
		]);
	console.log(`\n${table(sweep)}`);
	if (flags.out) {
		await writeFile(flags.out, JSON.stringify(similarities, null, 2));
		console.log(`Wrote ${flags.out}`);
	}
}

// ---------------------------------------------------------------------------
// --sm-recall

/**
 * Supermemory's retrieval on the same probes as --recall: every scenario's
 * setup prompts captured as conversations (assistant reply stubbed) plus the
 * distractor lines, in one container; each probe must surface its rule with
 * the plugin's filter (similarity >= 0.55, top 5).
 */
async function supermemoryRecall() {
	const sm = supermemoryClient(await supermemoryApiKey());
	const dreaming = flags["sm-dreaming"] as "instant" | "dynamic" | undefined;
	const containerTag = `ytimesy-eval-recall-${randomUUID().slice(0, 8)}`;
	const ids: string[] = [];
	const begun = Date.now();
	try {
		for (const scenario of SCENARIOS) {
			const contents = [
				...Object.values(scenario.seed ?? {}),
				...setupChats(scenario).flatMap(
					(chat) =>
						captureText(
							[
								{ kind: "userMessage", id: "u", text: chat.prompt },
								{ kind: "agentMessage", id: "a", text: "Done." },
							] as unknown as Parameters<typeof captureText>[0],
							new Date().toISOString(),
						) ?? [],
				),
			];
			for (const [index, content] of contents.entries())
				ids.push(
					(
						await sm.addDocument(
							content,
							containerTag,
							`${scenario.id}-${index}`,
							{ type: "session_turn", project: "fixture" },
							dreaming,
						)
					).id,
				);
		}
		ids.push(
			(
				await sm.addDocument(
					DISTRACTOR_LINES.map((line) => `- ${line.text}`).join("\n"),
					containerTag,
					"distractors",
					{ type: "seed", project: "fixture" },
					dreaming,
				)
			).id,
		);
		const waited = await waitProcessed(
			sm,
			ids,
			Math.max(30, Number(flags["sm-wait"]) || 900) * 1000,
			10_000,
		);
		console.log(
			`Ingested ${ids.length} documents in ${Math.round((Date.now() - begun) / 1000)}s (${waited.settled ? "settled" : `not settled: ${[...new Set(waited.statuses)].join(", ")}`}).`,
		);
		const rows = [
			["probe", "rule", "similarity", "rank", "recalled", "other hits >= 0.55"],
		];
		let recalled = 0;
		for (const probe of RECALL_PROBES) {
			const scenario = SCENARIOS.find((row) => row.id === probe.scenario);
			if (!scenario) continue;
			const response = await sm.profile(containerTag, probe.query);
			const hits = response.searchResults?.results ?? [];
			const text = (hit: (typeof hits)[number]) =>
				hit.memory ?? hit.chunk ?? hit.content ?? hit.text ?? "";
			const rank = hits.findIndex((hit) => scenario.leaks.test(text(hit))) + 1;
			const hit = rank ? hits[rank - 1] : undefined;
			const kept = recalledResults(response);
			const ok = Boolean(hit && kept.includes(hit));
			if (ok) recalled++;
			rows.push([
				probe.query.slice(0, 60),
				probe.scenario,
				hit?.similarity?.toFixed(3) ?? "-",
				rank ? String(rank) : "-",
				ok ? "yes" : "MISS",
				String(kept.filter((row) => row !== hit).length),
			]);
		}
		console.log(table(rows));
		console.log(
			`\nRecalled ${recalled}/${RECALL_PROBES.length} (plugin filter: top 5, similarity >= 0.55). A hit counts when its text matches the scenario's rule words.`,
		);
	} finally {
		const done = await sm.deleteContainer(containerTag).catch(() => null);
		console.log(
			done
				? `Deleted ${done.deletedDocumentsCount} documents and ${done.deletedMemoriesCount} memories.`
				: `Cleanup failed for ${containerTag}.`,
		);
	}
}

// ---------------------------------------------------------------------------
// --live

type ChatRecord = {
	sessionId: string | null;
	state: string;
	elapsedMs: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedTokens: number | null;
	memoryAttached: boolean;
	/** Supermemory arm: the plugin's context parts reached the model. */
	supermemoryAttached?: boolean;
	/** Supermemory MCP tools the agent called, in order. */
	supermemoryCalls?: string[];
	errors: string[];
};

type SupermemoryRecord = {
	containerTag: string;
	/** Per captured document (seed first, then each setup chat). */
	documents: {
		source: string;
		chars: number;
		settled: boolean;
		statuses: string[];
		ingestMs: number;
	}[];
	profileItems: number;
	recallQuery: string | null;
	/** Every search hit for the final prompt, before the 0.55 filter. */
	searchHits: { similarity: number | null; text: string }[];
	recalled: number;
	injectedLines: number;
	injectedChars: number;
	cleanup: string;
};

type MemoryCost = {
	kind: string;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
};

type ScenarioRecord = {
	arm: string;
	scenario: string;
	/** 1-based repeat index. */
	attempt: number;
	/** The eval user the run used. */
	evalUser: string;
	variant: string;
	elapsedMs: number;
	repo: string | null;
	passed: boolean | null;
	verifierOutput: string;
	dream: string;
	/** Setup chats, in order. */
	setup: ChatRecord[];
	chat2: ChatRecord | null;
	memoryCosts: MemoryCost[];
	supermemory?: SupermemoryRecord;
	errors: string[];
};

const LIVE_ARMS = ["off", "spec", "full", "supermemory"];

/** The --live flags, validated and bounded. */
function liveOptions() {
	const arms = flags.arms.split(",").map((arm) => arm.trim());
	if (!arms.every((arm) => LIVE_ARMS.includes(arm)))
		throw new Error("--arms accepts off, spec, full and supermemory.");
	const smDreaming = flags["sm-dreaming"] as "instant" | "dynamic" | undefined;
	if (smDreaming && !["instant", "dynamic"].includes(smDreaming))
		throw new Error("--sm-dreaming accepts instant or dynamic.");
	const model = flags.model;
	const effort = flags.effort;
	if (!/^[a-z0-9._-]+$/.test(model) || !/^[a-z]+$/.test(effort))
		throw new Error("Invalid --model or --effort.");
	const variant = harnessVariantFromFlags(flags.variant);
	return {
		arms,
		scenarios: selectScenarios(),
		model,
		effort,
		turnTimeoutMs:
			Math.min(900, Math.max(60, Number(flags["turn-timeout"]) || 300)) * 1000,
		dreamTimeoutMs:
			Math.min(900, Math.max(60, Number(flags["dream-timeout"]) || 600)) * 1000,
		smDreaming,
		smWaitMs:
			Math.min(3600, Math.max(30, Number(flags["sm-wait"]) || 900)) * 1000,
		variant,
		variantLabel: harnessVariantLabel(variant),
		repeat: Math.min(20, Math.max(1, Number(flags.repeat) || 1)),
		concurrency: Math.min(8, Math.max(1, Number(flags.concurrency) || 2)),
	};
}

type LiveOptions = ReturnType<typeof liveOptions>;

/**
 * Points this process at the development edge (after checking the database
 * is development's) and loads what only live runs need, so the offline
 * modes need no database, VM or model settings.
 */
async function liveEnvironment() {
	await assertDevelopmentDatabase();
	process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
	process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
	process.env.YTIMESY_MODEL_WORKFLOW_URL = DEVELOPMENT_EDGE_ORIGIN;
	process.env.YTIMESY_BACKGROUND_WORKFLOW_URL = DEVELOPMENT_EDGE_ORIGIN;
	process.env.YTIMESY_REALTIME_URL = DEVELOPMENT_EDGE_ORIGIN;
	process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
		await readFile(".ytimesy/realtime-development.json", "utf8"),
	).secret;
	const apiKey = process.env.FREESTYLE_API_KEY;
	if (!apiKey) throw new Error("Missing Freestyle API key.");

	const { Freestyle } = await import("freestyle");
	const { WorkspaceId } = await import("../src/domain/ids");
	const { sessionItemsFromUnknown } = await import(
		"../src/domain/session-item"
	);
	const { signDeliveryRequest } = await import("../src/domain/delivery-auth");
	const sessions = await import("../src/server/adapters/agent-sessions");
	const { claimApiTurn } = await import("../src/server/adapters/api-turns");
	const { dispatchBackgroundJob, withBackgroundJobDispatcher } = await import(
		"../src/server/adapters/background-job-dispatch"
	);
	const { closeDatabase, database } = await import(
		"../src/server/adapters/database"
	);
	const { workspaceBootSnapshotId } = await import(
		"../src/server/records/tools-snapshot-store"
	);
	const bootSnapshotId = await workspaceBootSnapshotId();
	const { GUEST_INTERNET_FIREWALL } = await import(
		"../src/server/adapters/freestyle/proof-vm"
	);
	const { waitUntilVmRunning } = await import(
		"../src/server/adapters/freestyle/wait-until-running"
	);
	const { createFreestyleWorkspaceMachines } = await import(
		"../src/server/adapters/freestyle/workspace-machines"
	);
	const { dispatchModelWorkflow, modelWorkflowSigningSecret } = await import(
		"../src/server/adapters/model-workflow-dispatch"
	);
	const { cancelServerTurn } = await import(
		"../src/server/services/cancel-server-turn"
	);
	const { sendSubscriptionTask } = await import(
		"../src/server/services/codex-subscription-session"
	);
	const { turnState } = await import("./smoke/builder-harness");
	return {
		client: new Freestyle({ apiKey }),
		machines: createFreestyleWorkspaceMachines(apiKey),
		db: database(),
		closeDatabase,
		bootSnapshotId,
		WorkspaceId,
		sessionItemsFromUnknown,
		signDeliveryRequest,
		sessions,
		claimApiTurn,
		dispatchBackgroundJob,
		withBackgroundJobDispatcher,
		GUEST_INTERNET_FIREWALL,
		waitUntilVmRunning,
		dispatchModelWorkflow,
		modelWorkflowSigningSecret,
		cancelServerTurn,
		sendSubscriptionTask,
		turnState,
	};
}

type LiveEnvironment = Awaited<ReturnType<typeof liveEnvironment>>;

/** One live run's settings, services and the resources still to clean up. */
type LiveRun = {
	options: LiveOptions;
	env: LiveEnvironment;
	sm: ReturnType<typeof supermemoryClient> | null;
	liveVms: Set<string>;
	liveContainers: Set<string>;
	stopping: () => boolean;
};

/** A signed probe must reach the dev edge before any VM is made. */
async function openExecutorGate(env: LiveEnvironment) {
	const url = `${DEVELOPMENT_EDGE_ORIGIN}/start`;
	const body = JSON.stringify({
		turnId: randomUUID(),
		leaseId: randomUUID(),
	});
	for (let attempt = 0; attempt < 30; attempt++) {
		const response = await fetch(url, {
			method: "POST",
			body,
			headers: await env.signDeliveryRequest(
				env.modelWorkflowSigningSecret(),
				"POST",
				url,
				body,
			),
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 409) return;
		if (response.status !== 503)
			throw new Error(`Executor preflight failed (${response.status}).`);
		await delay(2000);
	}
	throw new Error("Executor gate is not open.");
}

type ChatInput = {
	title: string;
	files: Record<string, string>;
	prompt: string;
	verify?: string;
	/** Context a competitor's hooks would add, as extra text parts. */
	extraParts?: readonly string[];
};

/** One chat, in a Codex slot shared with every other eval process. */
function chat(run: LiveRun, user: EvalUser, input: ChatInput) {
	return withSlot(
		"codex",
		SLOT_LIMITS.codex,
		() => chatNow(run, user, input),
		run.stopping,
	);
}

/** One chat: a new session on a fresh VM with the fixture files, one prompt, until settled. */
async function chatNow(run: LiveRun, user: EvalUser, input: ChatInput) {
	const { env, options } = run;
	const { userId } = user;
	const { projectId, workspaceId } = user.project;
	const extraParts = input.extraParts ?? [];
	const record: ChatRecord = {
		sessionId: null,
		state: "not-started",
		elapsedMs: 0,
		inputTokens: null,
		outputTokens: null,
		cachedTokens: null,
		memoryAttached: false,
		errors: [],
	};
	let vmId: string | undefined;
	let verified: { passed: boolean; output: string } | null = null;
	let finalItems: ReturnType<LiveEnvironment["sessionItemsFromUnknown"]> = [];
	try {
		const session = await env.sessions.insertAgentSession({
			userId,
			projectId,
			workspaceId,
			harness: "codex",
			title: input.title,
			listedModelId: options.model,
		});
		record.sessionId = session.id;
		const turnSeconds = Math.ceil(options.turnTimeoutMs / 1000);
		const created = await env.client.vms.create({
			slug: `ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
			snapshotId: env.bootSnapshotId,
			firewall: env.GUEST_INTERNET_FIREWALL,
			ttlSeconds: turnSeconds + 600,
			maxRunTotalSeconds: turnSeconds + 300,
			idleTimeoutSeconds: 300,
			automaticRestart: false,
			metadata: { purpose: "ytimesy-memory-eval" },
		});
		vmId = created.vmId;
		run.liveVms.add(vmId);
		await user.trackVm(vmId);
		await env.sessions.saveAgentSessionProviderRef(session.id, vmId);
		await env.waitUntilVmRunning(created.vm, "Memory eval");
		const workspace = env.WorkspaceId(vmId);
		const dir = await writeFixtureRepo(
			env,
			workspace,
			user.project.dirName,
			input.files,
		);
		await env.db.query("update agent_session set status='ready' where id=$1", [
			session.id,
		]);
		await env.withBackgroundJobDispatcher(
			async () => {},
			() =>
				env.sendSubscriptionTask(
					{ userId, projectId, sessionId: session.id },
					{
						modelId: options.model,
						text: `${input.prompt}${PROMPT_SUFFIX}`,
						variant: options.effort,
					},
				),
		);
		if (extraParts.length) await attachExtraParts(env, session.id, extraParts);
		const started = Date.now();
		await admitTurn(env, session.id, started);
		finalItems = await followTurn(run, userId, session.id, record, {
			started,
			watchSupermemory: extraParts.length > 0,
		});
		record.elapsedMs = Date.now() - started;
		record.supermemoryCalls = finalItems.flatMap((item) =>
			(item.kind === "mcpToolCall" && item.server === "supermemory") ||
			(item.kind === "dynamicToolCall" && /supermemory/i.test(item.tool))
				? [item.tool]
				: [],
		);
		if (input.verify) {
			const result = await env.machines.exec(
				workspace,
				`cd '${dir}' && ${shellCommand(input.verify)}`,
				60_000,
			);
			verified = {
				passed: result.exitCode === 0,
				output: `${result.stdout}${result.stderr}`.trim().slice(-400),
			};
		}
	} catch (error) {
		record.errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		if (record.sessionId)
			await env.cancelServerTurn(userId, record.sessionId).catch(() => {});
		if (vmId) {
			const id = vmId;
			await env.client.vms
				.delete(id)
				.then(() => run.liveVms.delete(id))
				.catch(() => {});
		}
	}
	return { record, verified, items: finalItems };
}

/** Writes `files` under ~/`dirName` on the VM as a one-commit repo; returns its path. */
async function writeFixtureRepo(
	env: LiveEnvironment,
	workspace: ReturnType<LiveEnvironment["WorkspaceId"]>,
	dirName: string,
	files: Record<string, string>,
) {
	const home = (
		await env.machines.exec(workspace, 'printf %s "$HOME"', 15_000)
	).stdout.trim();
	if (!home.startsWith("/")) throw new Error("VM home is unavailable.");
	const dir = `${home}/${dirName}`;
	const directories = new Set(
		Object.keys(files)
			.filter((path) => path.includes("/"))
			.map((path) => `${dir}/${path.slice(0, path.lastIndexOf("/"))}`),
	);
	await env.machines.exec(
		workspace,
		`mkdir -p ${[dir, ...directories].map((path) => `'${path}'`).join(" ")}`,
		15_000,
	);
	for (const [path, content] of Object.entries(files))
		await env.machines.writeTextFile(workspace, `${dir}/${path}`, content);
	const setup = await env.machines.exec(
		workspace,
		`${fixtureRepoScript(dir)} && printf '%s\\n' '${dir}' > /tmp/ytimesy-project-cwd`,
		20_000,
	);
	if (setup.exitCode) throw new Error("Fixture repository setup failed.");
	return dir;
}

/**
 * Adds context a competitor's hooks would add, as extra text parts on the
 * queued user message (where our read hook puts memory), before admission.
 */
async function attachExtraParts(
	env: LiveEnvironment,
	sessionId: string,
	extraParts: readonly string[],
) {
	const queued = (
		await env.db.query<{
			id: string;
			messages: { role: string; content: unknown }[];
		}>(
			"select id,messages from api_turn where session_id=$1 and state='queued' order by created_at desc limit 1",
			[sessionId],
		)
	).rows[0];
	const messages = [...(queued?.messages ?? [])];
	const index = messages.map((m) => m.role).lastIndexOf("user");
	if (!queued || index < 0)
		throw new Error("No queued user message to attach context to.");
	const own = messages[index].content;
	messages[index] = {
		...messages[index],
		content: [
			...(typeof own === "string"
				? [{ type: "text", text: own }]
				: (own as unknown[])),
			...extraParts.map((text) => ({ type: "text", text })),
		],
	};
	const updated = await env.db.query(
		"update api_turn set messages=$2::jsonb,updated_at=now() where id=$1 and state='queued'",
		[queued.id, JSON.stringify(messages)],
	);
	if (updated.rowCount !== 1)
		throw new Error("The turn left the queue before context was attached.");
}

/** Claims and dispatches the queued turn, as the dev edge's admission would. */
async function admitTurn(
	env: LiveEnvironment,
	sessionId: string,
	started: number,
) {
	while (Date.now() - started < 120_000) {
		const turn = await env.claimApiTurn(1, 64, "durable-object", sessionId);
		if (turn?.lease_id) {
			await env.dispatchModelWorkflow(turn);
			return;
		}
		if ((await env.turnState(sessionId))?.state !== "queued") return;
		await delay(2000);
	}
	throw new Error("Turn was not admitted within two minutes.");
}

/**
 * Polls the turn until it settles, recording its usage and whether memory
 * (or Supermemory's parts) reached the model; cancels it past the timeout.
 */
async function followTurn(
	run: LiveRun,
	userId: string,
	sessionId: string,
	record: ChatRecord,
	{ started, watchSupermemory }: { started: number; watchSupermemory: boolean },
) {
	const { env } = run;
	const { turnTimeoutMs } = run.options;
	let items: ReturnType<LiveEnvironment["sessionItemsFromUnknown"]> = [];
	let cancelled = false;
	for (;;) {
		const state = await env.turnState(sessionId);
		items = env.sessionItemsFromUnknown(state?.items);
		record.state = state?.state ?? "missing";
		const usage = items.find((item) => item.kind === "userMessage")?.apiUsage;
		if (usage) {
			record.inputTokens = usage.inputTokens;
			record.outputTokens = usage.outputTokens;
			record.cachedTokens = usage.cacheReadTokens;
		}
		const sent = JSON.stringify(state?.messages ?? []);
		record.memoryAttached = sent.includes(MEMORY_PART_OPEN);
		if (watchSupermemory)
			record.supermemoryAttached = sent.includes("<supermemory-");
		if (state && !["queued", "running"].includes(state.state)) return items;
		if (Date.now() > started + turnTimeoutMs && !cancelled) {
			cancelled = true;
			record.errors.push(`Cancelled: exceeded ${turnTimeoutMs / 1000}s.`);
			await env.cancelServerTurn(userId, sessionId);
		}
		if (Date.now() > started + turnTimeoutMs + 60_000) {
			record.state = "unsettled";
			return items;
		}
		await delay(2000);
	}
}

/**
 * Writes memory files before any chat, through the same Worker-side Git
 * writer dreaming uses, with a short-lived token from wrangler.
 */
async function seedRepo(name: string, files: Record<string, string>) {
	const created = await runCommand("npx", [
		"wrangler",
		"artifacts",
		"repos",
		"create",
		name,
		"--namespace",
		MEMORY_NAMESPACE,
		"--default-branch",
		"main",
		"--json",
	]);
	const { remote, token } = JSON.parse(created.stdout) as {
		remote: string;
		token: string;
	};
	const { pushChanges } = await import("../src/server/adapters/memory-repos");
	const http = (await import("isomorphic-git/http/web")).default;
	const outcome = await pushChanges({
		http,
		remote,
		token: token.split("?expires=")[0],
		base: { head: null, files: {} },
		changes: Object.entries(files).map(([path, content]) => ({
			path,
			content,
		})),
		message: "Seed memory for the eval",
	});
	if (outcome === "raced" || !outcome.ok)
		throw new Error(`Seeding ${name} failed.`);
}

/** Dreams now instead of after the idle delay, and waits for it to finish. */
async function dreamNow(run: LiveRun, userId: string, after: Date) {
	const { env } = run;
	await env.dispatchBackgroundJob({
		id: randomUUID(),
		kind: "memory",
		action: "dream",
		userId,
	});
	const deadline = Date.now() + run.options.dreamTimeoutMs;
	while (Date.now() < deadline) {
		const row = (
			await env.db.query<{ outcome: string }>(
				"select outcome from memory_model_usage where user_id=$1 and kind='dream' and created_at>$2 order by created_at desc limit 1",
				[userId, after],
			)
		).rows[0];
		if (row) return row.outcome;
		await delay(5000);
	}
	return "timeout";
}

async function memoryCosts(
	env: LiveEnvironment,
	userId: string,
	since: Date,
): Promise<MemoryCost[]> {
	return (
		await env.db.query<{
			kind: string;
			calls: string;
			input: string | null;
			output: string | null;
			cached: string | null;
		}>(
			`select kind,count(*) as calls,sum(input_tokens) as input,sum(output_tokens) as output,sum(cache_read_tokens) as cached
			 from memory_model_usage where user_id=$1 and created_at>$2 group by kind order by kind`,
			[userId, since],
		)
	).rows.map((row) => ({
		kind: row.kind,
		calls: Number(row.calls),
		inputTokens: Number(row.input ?? 0),
		outputTokens: Number(row.output ?? 0),
		cachedTokens: Number(row.cached ?? 0),
	}));
}

function scenarioRecord(
	run: LiveRun,
	user: EvalUser,
	arm: string,
	scenario: Scenario,
	attempt: number,
	repo: string | null,
): ScenarioRecord {
	return {
		arm,
		scenario: scenario.id,
		attempt,
		evalUser: user.userId,
		variant: run.options.variantLabel,
		elapsedMs: 0,
		repo,
		passed: null,
		verifierOutput: "",
		dream: "none",
		setup: [],
		chat2: null,
		memoryCosts: [],
		errors: [],
	};
}

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** One (arm, scenario, repeat) on our memory: off, spec or full. */
async function runScenario(
	run: LiveRun,
	user: EvalUser,
	arm: string,
	scenario: Scenario,
	attempt: number,
): Promise<ScenarioRecord> {
	if (arm === "supermemory")
		return runSupermemoryScenario(run, user, scenario, attempt);
	const { repeat, variantLabel } = run.options;
	const started = new Date();
	const repo =
		arm === "off"
			? null
			: `memory-eval-${arm}-${scenario.id}-${randomUUID().slice(0, 8)}`;
	const result = scenarioRecord(run, user, arm, scenario, attempt, repo);
	try {
		// The repo is deleted when the eval user is released.
		await user.setMemory(arm as "off" | "spec" | "full", repo);
		if (arm !== "off") {
			if (repo && scenario.seed) await seedRepo(repo, scenario.seed);
			const dreams: string[] = [];
			for (const [index, setup] of setupChats(scenario).entries()) {
				const done = await chat(run, user, {
					title: `Memory eval ${scenario.id} chat ${index + 1}`,
					files: setup.files,
					prompt: setup.prompt,
				});
				result.setup.push(done.record);
				// The save hook (full) is queued when the chat's turn completes.
				if (arm === "full") await delay(30_000);
				dreams.push(await dreamNow(run, user.userId, new Date()));
			}
			result.dream = dreams.join(",") || "none";
		}
		const second = await chat(run, user, {
			title: `Memory eval ${scenario.id} chat 2`,
			files: scenario.chat2.files,
			prompt: scenario.chat2.prompt,
			verify: scenario.verify,
		});
		result.chat2 = second.record;
		result.passed = second.verified?.passed ?? null;
		result.verifierOutput = second.verified?.output ?? "";
		// Chat 2's own save hook may still be running; let it land in the costs.
		if (arm === "full") await delay(20_000);
		result.memoryCosts = await memoryCosts(run.env, user.userId, started);
	} catch (error) {
		result.errors.push(errorText(error));
	}
	result.elapsedMs = Date.now() - started.getTime();
	console.log(
		`[${arm}${repeat > 1 ? ` #${attempt}` : ""}${variantLabel === "default" ? "" : ` ${variantLabel}`}] ${scenario.id}: ${result.passed === null ? "no verdict" : result.passed ? "PASS" : "fail"} (dream ${result.dream}${result.chat2?.memoryAttached ? ", memory attached to chat 2" : ""})${result.errors.length ? ` errors: ${result.errors.join("; ")}` : ""}`,
	);
	return result;
}

/**
 * Supermemory's Claude Code plugin with its defaults: our memory off; each
 * setup chat captured (capture.js) into a fresh container and processed;
 * the final chat gets session-start's profile and the prompt recall as
 * extra text parts. Their MCP search tools are not offered (see notes).
 */
async function runSupermemoryScenario(
	run: LiveRun,
	user: EvalUser,
	scenario: Scenario,
	attempt: number,
): Promise<ScenarioRecord> {
	const { sm } = run;
	const { smDreaming, smWaitMs } = run.options;
	const repoName = user.project.dirName;
	if (!sm) throw new Error("Supermemory is not configured.");
	const started = new Date();
	const containerTag = `ytimesy-eval-${scenario.id}-${randomUUID().slice(0, 8)}`;
	const record: SupermemoryRecord = {
		containerTag,
		documents: [],
		profileItems: 0,
		recallQuery: null,
		searchHits: [],
		recalled: 0,
		injectedLines: 0,
		injectedChars: 0,
		cleanup: "pending",
	};
	const result = scenarioRecord(
		run,
		user,
		"supermemory",
		scenario,
		attempt,
		null,
	);
	result.supermemory = record;
	run.liveContainers.add(containerTag);
	const ingest = async (
		source: string,
		content: string,
		customId: string,
		metadata: Record<string, string>,
	) => {
		const begun = Date.now();
		const doc = await sm.addDocument(
			content,
			containerTag,
			customId,
			{
				project: repoName,
				sm_scope: "personal",
				sm_capture_mode: "automatic",
				timestamp: new Date().toISOString(),
				...metadata,
			},
			smDreaming,
		);
		const waited = await waitProcessed(sm, [doc.id], smWaitMs);
		record.documents.push({
			source,
			chars: content.length,
			...waited,
			ingestMs: Date.now() - begun,
		});
	};
	try {
		await user.setMemory("off", null);
		// Seeded memory (expired-rule): the same lines as one document.
		const seeded = scenario.seed?.["MEMORY.md"];
		if (seeded)
			await ingest("seed", seeded, `seed-${randomUUID()}`, { type: "seed" });
		for (const [index, setup] of setupChats(scenario).entries()) {
			const turnStarted = new Date().toISOString();
			const done = await chat(run, user, {
				title: `Memory eval ${scenario.id} chat ${index + 1}`,
				files: setup.files,
				prompt: setup.prompt,
			});
			result.setup.push(done.record);
			const content = captureText(done.items, turnStarted);
			if (!content || !done.record.sessionId) {
				result.errors.push(`Setup chat ${index + 1} had nothing to capture.`);
				continue;
			}
			await ingest(`chat${index + 1}`, content, done.record.sessionId, {
				type: "session_turn",
			});
		}
		result.dream = record.documents
			.map(
				(doc) =>
					`${doc.source} ${Math.round(doc.ingestMs / 1000)}s ${doc.statuses.join("/")}`,
			)
			.join(", ");
		// session-start.js (profile, q = project name), then recall-directive.js.
		const prompt = `${scenario.chat2.prompt}${PROMPT_SUFFIX}`;
		const startProfile = await sm
			.profile(containerTag, repoName)
			.catch(() => null);
		const start = sessionStartContext(startProfile, containerTag, repoName);
		record.profileItems = start.items;
		record.recallQuery = recallQuery(prompt);
		let recall: string | null = null;
		if (record.recallQuery) {
			const searched: ProfileResponse | null = await sm
				.profile(containerTag, record.recallQuery)
				.catch(() => null);
			record.searchHits = (searched?.searchResults?.results ?? []).map(
				(hit) => ({
					similarity: Number.isFinite(hit.similarity)
						? (hit.similarity as number)
						: null,
					text: (
						hit.memory ??
						hit.chunk ??
						hit.content ??
						hit.text ??
						""
					).slice(0, 200),
				}),
			);
			const hits = recalledResults(searched);
			record.recalled = hits.length;
			recall = recallContext(hits, containerTag);
		}
		const parts = [start.text, ...(recall ? [recall] : [])];
		record.injectedChars = parts.join("\n").length;
		record.injectedLines = parts
			.join("\n")
			.split("\n")
			.filter((line) => line.startsWith("- ◪")).length;
		const second = await chat(run, user, {
			title: `Memory eval ${scenario.id} chat 2`,
			files: scenario.chat2.files,
			prompt: scenario.chat2.prompt,
			verify: scenario.verify,
			extraParts: parts,
		});
		result.chat2 = second.record;
		result.passed = second.verified?.passed ?? null;
		result.verifierOutput = second.verified?.output ?? "";
		result.memoryCosts = await memoryCosts(run.env, user.userId, started);
	} catch (error) {
		result.errors.push(errorText(error));
	} finally {
		record.cleanup = await sm.deleteContainer(containerTag).then(
			(done) =>
				`deleted ${done.deletedDocumentsCount} documents, ${done.deletedMemoriesCount} memories`,
			(error: Error) => `cleanup failed: ${error.message}`,
		);
		run.liveContainers.delete(containerTag);
	}
	result.elapsedMs = Date.now() - started.getTime();
	console.log(
		`[supermemory] ${scenario.id}: ${result.passed === null ? "no verdict" : result.passed ? "PASS" : "fail"} (ingest ${result.dream || "none"}; injected ${record.injectedLines} lines/${record.injectedChars} chars, recalled ${record.recalled}, profile ${record.profileItems}; top hit ${record.searchHits[0]?.similarity?.toFixed(3) ?? "-"})${result.errors.length ? ` errors: ${result.errors.join("; ")}` : ""}`,
	);
	return result;
}

/**
 * Every (arm, scenario, repeat), each as its own eval user, `concurrency` at
 * a time. Returns the results and whatever a user's release left behind.
 */
async function runAllScenarios(run: LiveRun) {
	const { arms, scenarios, repeat, concurrency, variant, variantLabel } =
		run.options;
	const jobs = arms.flatMap((arm) =>
		scenarios.flatMap((scenario) =>
			Array.from({ length: repeat }, (_, index) => ({
				arm,
				scenario,
				attempt: index + 1,
			})),
		),
	);
	console.log(
		`Running ${jobs.length} scenario runs (${arms.join(",")} x ${scenarios.length} scenarios x ${repeat}), concurrency ${concurrency}, variant ${variantLabel}, one eval user per run.`,
	);
	const results: ScenarioRecord[] = [];
	const leftovers: string[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
			while (next < jobs.length && !run.stopping()) {
				const { arm, scenario, attempt } = jobs[next++];
				let user: EvalUser | null = null;
				try {
					user = await createEvalUser({
						label: `memory-eval ${arm} ${scenario.id} #${attempt} ${variantLabel}`,
						variant,
						keepRepos: flags["keep-repos"],
					});
					results.push(await runScenario(run, user, arm, scenario, attempt));
				} catch (error) {
					console.error(
						`[${arm} #${attempt}] ${scenario.id}: ${errorText(error)}`,
					);
				} finally {
					if (user) leftovers.push(...(await user.release()));
				}
			}
		}),
	);
	return { results, leftovers };
}

/** Deletes VMs and containers a stopped or failed run left, then closes the database. */
async function cleanUpLiveRun(run: LiveRun) {
	for (const id of run.liveVms)
		await run.env.client.vms.delete(id).catch(() => {});
	for (const tag of run.liveContainers)
		await run.sm?.deleteContainer(tag).catch(() => {});
	await run.env.closeDatabase();
}

/** Per-arm totals, then one row per scenario run. */
function printLiveReport(
	options: LiveOptions,
	results: ScenarioRecord[],
	startedAt: number,
) {
	const priceIn = Number(flags["price-in"]);
	const priceOut = Number(flags["price-out"]);
	const dollars = (input: number, output: number) =>
		Number.isFinite(priceIn) && Number.isFinite(priceOut)
			? `$${((input * priceIn + output * priceOut) / 1e6).toFixed(4)}`
			: "n/a";
	const sum = (values: (number | null | undefined)[]) =>
		values.reduce<number>((total, value) => total + (value ?? 0), 0);
	const rows = [
		[
			"arm",
			"pass",
			"chat2 in tok",
			"chat2 out tok",
			"chat2 cache%",
			"chat2 attached",
			"save in/out tok",
			"save $",
			"dream in/out tok",
			"dream $",
		],
	];
	for (const arm of options.arms) {
		const runs = results.filter((row) => row.arm === arm);
		const chat2 = runs.map((row) => row.chat2);
		const input = sum(chat2.map((c) => c?.inputTokens));
		const cost = (kind: string) => {
			const rowsOfKind = runs.flatMap((row) =>
				row.memoryCosts.filter((entry) => entry.kind === kind),
			);
			const tokensIn = sum(rowsOfKind.map((entry) => entry.inputTokens));
			const tokensOut = sum(rowsOfKind.map((entry) => entry.outputTokens));
			return [`${tokensIn}/${tokensOut}`, dollars(tokensIn, tokensOut)];
		};
		rows.push([
			arm,
			`${runs.filter((row) => row.passed).length}/${runs.length}`,
			String(input),
			String(sum(chat2.map((c) => c?.outputTokens))),
			input
				? `${Math.round((sum(chat2.map((c) => c?.cachedTokens)) / input) * 100)}%`
				: "-",
			`${chat2.filter((c) => c?.memoryAttached || c?.supermemoryAttached).length}/${runs.length}`,
			...cost("save"),
			...cost("dream"),
		]);
	}
	console.log(`\n${table(rows)}`);
	const perScenario = [
		[
			"arm",
			"scenario",
			"#",
			"pass",
			"secs",
			"chat2 in tok",
			"attached",
			"injected",
			"ingest",
		],
	];
	for (const row of results)
		perScenario.push([
			row.arm,
			row.scenario,
			String(row.attempt),
			row.passed === null ? "-" : row.passed ? "PASS" : "fail",
			String(Math.round(row.elapsedMs / 1000)),
			String(row.chat2?.inputTokens ?? "-"),
			row.chat2?.memoryAttached || row.chat2?.supermemoryAttached
				? "yes"
				: "no",
			row.supermemory
				? `${row.supermemory.injectedLines} lines/${row.supermemory.injectedChars} chars`
				: "-",
			row.supermemory
				? row.supermemory.documents
						.map((doc) => `${Math.round(doc.ingestMs / 1000)}s`)
						.join("+") || "-"
				: "-",
		]);
	console.log(`\n${table(perScenario)}`);
	console.log(
		`\nModel ${options.model} (${options.effort}); variant ${options.variantLabel}; total ${Math.round((Date.now() - startedAt) / 1000)}s. Chat token columns are chat 2's agent turns; save and dream columns are memory jobs on the user's route.`,
	);
}

async function live() {
	const options = liveOptions();
	const sm = options.arms.includes("supermemory")
		? supermemoryClient(await supermemoryApiKey())
		: null;
	const env = await liveEnvironment();
	await openExecutorGate(env);
	let stopping = false;
	onEvalStop(() => {
		stopping = true;
	});
	const liveRun: LiveRun = {
		options,
		env,
		sm,
		liveVms: new Set(),
		liveContainers: new Set(),
		stopping: () => stopping,
	};
	const startedAt = Date.now();
	let outcome: Awaited<ReturnType<typeof runAllScenarios>>;
	try {
		outcome = await runAllScenarios(liveRun);
	} finally {
		await cleanUpLiveRun(liveRun);
	}
	const { results, leftovers } = outcome;
	if (leftovers.length) {
		console.error(`Cleanup incomplete: ${leftovers.join(", ")}.`);
		process.exitCode = 1;
	}
	printLiveReport(options, results, startedAt);
	const out =
		flags.out ??
		`/tmp/memory-two-chat-eval-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}.json`;
	await writeFile(out, JSON.stringify({ flags, results }, null, 2));
	console.log(`Wrote ${out}`);
}

if (flags["dry-run"]) await dryRun();
else if (flags.recall) await recall();
else if (flags["sm-recall"]) await supermemoryRecall();
else if (flags.live) await live();
else
	throw new Error(
		"Pass --dry-run (verifiers), --recall (offline line retrieval), --sm-recall (Supermemory retrieval) or --live (dev two-chat runs).",
	);
