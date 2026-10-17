// Does cross-chat memory (Agent Memory Repo) help? Development only.
//
//   node --import tsx scripts/memory-two-chat-eval.ts --dry-run
//       Offline: every scenario verifier passes a rule-following answer and
//       fails a rule-breaking one, and chat 2 never leaks the rule.
//   CLOUDFLARE_ACCOUNT_ID=f45021db74a97feaafae2e3e131d4d82 CLOUDFLARE_API_TOKEN=$(npx wrangler auth token) \
//     node --import tsx scripts/memory-two-chat-eval.ts --recall
//       Offline line retrieval with the read hook's embeddings: requests in
//       different words than the saved rule must surface it.
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
// (docs/parallel-evals.md). --as-owner runs as the dev owner, one at a time.
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
	memoryLineEmbeddingText,
} from "../src/domain/memory-repo";
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
	createEvalUser,
	type EvalUser,
	onEvalStop,
	SLOT_LIMITS,
	withSlot,
} from "./smoke/eval-user";

const run = promisify(execFile);

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
		/** Run as the dev owner (old behaviour; forces concurrency 1). */
		"as-owner": { type: "boolean", default: false },
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
		await run("bash", ["-c", fixtureRepoScript(dir)]);
		await writeFiles(dir, solution);
		try {
			await run("bash", ["-c", shellCommand(scenario.verify)], {
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
 * The read hook's ranking on real embeddings: every scenario rule plus
 * distractors as memory lines; each probe must put its rule in the top
 * lines above the cutoff.
 */
async function recall() {
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
	];
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
		similarities.push(
			...lines.map((line, index) => ({
				probe: probe.query,
				line: line.text,
				right: line.id === probe.scenario,
				score: cosineSimilarity(query, vectors[index]),
			})),
		);
		const ranked = lines
			.map((line, index) => ({
				...line,
				score: cosineSimilarity(query, vectors[index]),
			}))
			.sort((a, b) => b.score - a.score);
		const rank = ranked.findIndex((line) => line.id === probe.scenario) + 1;
		const hit = ranked[rank - 1];
		const ok =
			rank > 0 &&
			rank <= MEMORY_MATCH_LIMIT &&
			hit.score >= MEMORY_MATCH_MIN_SIMILARITY;
		if (ok) recalled++;
		// What the hook would also inject: other lines in the top five above the cutoff.
		const noise = ranked
			.slice(0, MEMORY_MATCH_LIMIT)
			.filter(
				(line) =>
					line.id !== probe.scenario &&
					line.score >= MEMORY_MATCH_MIN_SIMILARITY,
			).length;
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
	/** The eval user the run used ("owner" with --as-owner). */
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

async function live() {
	const arms = flags.arms.split(",").map((arm) => arm.trim());
	if (
		!arms.every((arm) => ["off", "spec", "full", "supermemory"].includes(arm))
	)
		throw new Error("--arms accepts off, spec, full and supermemory.");
	const smKey = arms.includes("supermemory") ? await supermemoryApiKey() : null;
	const sm = smKey ? supermemoryClient(smKey) : null;
	const smDreaming = flags["sm-dreaming"] as "instant" | "dynamic" | undefined;
	if (smDreaming && !["instant", "dynamic"].includes(smDreaming))
		throw new Error("--sm-dreaming accepts instant or dynamic.");
	const smWaitMs =
		Math.min(3600, Math.max(30, Number(flags["sm-wait"]) || 900)) * 1000;
	const model = flags.model;
	const effort = flags.effort;
	if (!/^[a-z0-9._-]+$/.test(model) || !/^[a-z]+$/.test(effort))
		throw new Error("Invalid --model or --effort.");
	const turnTimeoutMs =
		Math.min(900, Math.max(60, Number(flags["turn-timeout"]) || 300)) * 1000;
	const dreamTimeoutMs =
		Math.min(900, Math.max(60, Number(flags["dream-timeout"]) || 600)) * 1000;
	const scenarios = selectScenarios();

	const DEV_REF = "zqkptvyvoyqqtpihlshw";
	const ORIGIN =
		"https://ytimesy-edge-executor-development.hetkp8044.workers.dev";
	const NAMESPACE = "ytimesy-memory-development";
	if (!new URL(process.env.DATABASE_URL ?? "").username.includes(DEV_REF))
		throw new Error(
			"Refusing to run: DATABASE_URL is not the development project.",
		);
	process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
	process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
	process.env.YTIMESY_MODEL_WORKFLOW_URL = ORIGIN;
	process.env.YTIMESY_BACKGROUND_WORKFLOW_URL = ORIGIN;
	process.env.YTIMESY_REALTIME_URL = ORIGIN;
	process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
		await readFile(".ytimesy/realtime-development.json", "utf8"),
	).secret;
	const apiKey = process.env.FREESTYLE_API_KEY;
	if (!apiKey) throw new Error("Missing Freestyle API key.");

	// Loaded only here so the offline modes need no database, VM or model settings.
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

	const client = new Freestyle({ apiKey });
	const machines = createFreestyleWorkspaceMachines(apiKey);
	const db = database();
	const liveVms = new Set<string>();
	const liveProjects = new Set<string>();
	const liveRepos = new Set<string>();
	const liveContainers = new Set<string>();

	const variant = harnessVariantFromFlags(flags.variant);
	const variantLabel = harnessVariantLabel(variant);
	const asOwner = flags["as-owner"];
	const repeat = Math.min(20, Math.max(1, Number(flags.repeat) || 1));
	// Memory settings are per user: the owner can only run one scenario at a time.
	const concurrency = asOwner
		? 1
		: Math.min(8, Math.max(1, Number(flags.concurrency) || 2));
	const owner = asOwner
		? await createEvalUser({ label: "memory-eval", asOwner: true, variant })
		: null;
	// The owner's own memory settings, restored at the end (--as-owner only).
	const savedSettings = owner
		? (
				await db.query<{
					mode: string;
					repo: string | null;
					dreamed_through: Date | null;
				}>(
					"select mode,repo,dreamed_through from user_memory where user_id=$1",
					[owner.userId],
				)
			).rows[0]
		: undefined;

	// Executor gate: a signed probe must reach the dev edge before any VM is made.
	{
		const url = `${ORIGIN}/start`;
		const body = JSON.stringify({
			turnId: randomUUID(),
			leaseId: randomUUID(),
		});
		let open = false;
		for (let attempt = 0; attempt < 30 && !open; attempt++) {
			const response = await fetch(url, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(
					modelWorkflowSigningSecret(),
					"POST",
					url,
					body,
				),
				signal: AbortSignal.timeout(15_000),
			});
			if (response.status === 409) open = true;
			else if (response.status !== 503)
				throw new Error(`Executor preflight failed (${response.status}).`);
			else await delay(2000);
		}
		if (!open) throw new Error("Executor gate is not open.");
	}

	async function setEvalMemory(
		user: EvalUser,
		mode: "off" | "spec" | "full",
		repo: string | null,
	) {
		if (!user.asOwner) return user.setMemory(mode, repo);
		await db.query(
			`insert into user_memory(user_id,mode,repo,dreamed_through) values($1,$2,$3,now())
			 on conflict(user_id) do update set mode=excluded.mode,repo=excluded.repo,dreamed_through=excluded.dreamed_through,updated_at=now()`,
			[user.userId, mode, repo],
		);
	}

	/** An eval user's own project; a copied one for the owner. */
	async function throwawayProject(user: EvalUser) {
		if (!user.asOwner)
			return {
				projectId: user.project.projectId,
				workspaceId: user.project.workspaceId,
			};
		const id = randomUUID();
		await db.query(
			`insert into project select (jsonb_populate_record(null::project,
				to_jsonb(p) || jsonb_build_object('id', $2::uuid, 'repository_id', $3::bigint, 'created_at', now()))).*
			 from project p where p.id=$1`,
			[
				user.project.projectId,
				id,
				9_000_000_000 + Math.floor(Math.random() * 1e9),
			],
		);
		liveProjects.add(id);
		const workspaceId = randomUUID();
		await db.query(
			`insert into workspace select (jsonb_populate_record(null::workspace,
				to_jsonb(w) || jsonb_build_object('id', $2::uuid, 'project_id', $3::uuid))).*
			 from workspace w where w.id=$1`,
			[user.project.workspaceId, workspaceId, id],
		);
		return { projectId: id, workspaceId };
	}

	async function dropProject(user: EvalUser, id: string) {
		// An eval user's project goes with the user.
		if (!user.asOwner) return;
		await db.query("delete from project where id=$1 and user_id=$2", [
			id,
			user.userId,
		]);
		liveProjects.delete(id);
	}

	async function deleteRepo(name: string) {
		await run("npx", [
			"wrangler",
			"artifacts",
			"repos",
			"delete",
			name,
			"--namespace",
			NAMESPACE,
			"-y",
		]).catch(() => {});
		liveRepos.delete(name);
	}

	async function turnState(sessionId: string) {
		return (
			await db.query<{ state: string; items: unknown; messages: unknown }>(
				"select t.state,s.items,t.messages from api_turn t join agent_session s on s.id=t.session_id where t.session_id=$1 order by t.created_at desc limit 1",
				[sessionId],
			)
		).rows[0];
	}

	/** One chat: a new session on a fresh VM with `files`, one prompt, until settled. */
	/** One chat, in a Codex slot shared with every other eval process. */
	function chat(...args: Parameters<typeof chatNow>) {
		return withSlot(
			"codex",
			SLOT_LIMITS.codex,
			() => chatNow(...args),
			() => stopping,
		);
	}

	async function chatNow(
		user: EvalUser,
		{ projectId, workspaceId }: { projectId: string; workspaceId: string },
		title: string,
		files: Record<string, string>,
		prompt: string,
		verify?: string,
		extraParts: readonly string[] = [],
	) {
		const { userId } = user;
		const repoName = user.project.dirName;
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
		let finalItems: ReturnType<typeof sessionItemsFromUnknown> = [];
		try {
			const session = await sessions.insertAgentSession({
				userId,
				projectId,
				workspaceId,
				harness: "codex",
				title,
				listedModelId: model,
			});
			record.sessionId = session.id;
			const created = await client.vms.create({
				slug: `ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
				snapshotId: bootSnapshotId,
				firewall: GUEST_INTERNET_FIREWALL,
				ttlSeconds: Math.ceil(turnTimeoutMs / 1000) + 600,
				maxRunTotalSeconds: Math.ceil(turnTimeoutMs / 1000) + 300,
				idleTimeoutSeconds: 300,
				automaticRestart: false,
				metadata: { purpose: "ytimesy-memory-eval" },
			});
			vmId = created.vmId;
			liveVms.add(vmId);
			await user.trackVm(vmId);
			await sessions.saveAgentSessionProviderRef(session.id, vmId);
			await waitUntilVmRunning(created.vm, "Memory eval");
			const workspace = WorkspaceId(vmId);
			const home = (
				await machines.exec(workspace, 'printf %s "$HOME"', 15_000)
			).stdout.trim();
			if (!home.startsWith("/")) throw new Error("VM home is unavailable.");
			const dir = `${home}/${repoName}`;
			const directories = new Set(
				Object.keys(files)
					.filter((path) => path.includes("/"))
					.map((path) => `${dir}/${path.slice(0, path.lastIndexOf("/"))}`),
			);
			await machines.exec(
				workspace,
				`mkdir -p ${[dir, ...directories].map((path) => `'${path}'`).join(" ")}`,
				15_000,
			);
			for (const [path, content] of Object.entries(files))
				await machines.writeTextFile(workspace, `${dir}/${path}`, content);
			const setup = await machines.exec(
				workspace,
				`${fixtureRepoScript(dir)} && printf '%s\\n' '${dir}' > /tmp/ytimesy-project-cwd`,
				20_000,
			);
			if (setup.exitCode) throw new Error("Fixture repository setup failed.");
			await db.query("update agent_session set status='ready' where id=$1", [
				session.id,
			]);
			await withBackgroundJobDispatcher(
				async () => {},
				() =>
					sendSubscriptionTask(
						{ userId, projectId, sessionId: session.id },
						{
							modelId: model,
							text: `${prompt}${PROMPT_SUFFIX}`,
							variant: effort,
						},
					),
			);
			// Context a competitor's hooks would add, as extra text parts on the
			// queued user message (where our read hook puts memory), before admission.
			if (extraParts.length) {
				const queued = (
					await db.query<{
						id: string;
						messages: { role: string; content: unknown }[];
					}>(
						"select id,messages from api_turn where session_id=$1 and state='queued' order by created_at desc limit 1",
						[session.id],
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
				const updated = await db.query(
					"update api_turn set messages=$2::jsonb,updated_at=now() where id=$1 and state='queued'",
					[queued.id, JSON.stringify(messages)],
				);
				if (updated.rowCount !== 1)
					throw new Error(
						"The turn left the queue before context was attached.",
					);
			}
			const started = Date.now();
			let admitted = false;
			while (!admitted && Date.now() - started < 120_000) {
				const turn = await claimApiTurn(1, 64, "durable-object", session.id);
				if (turn?.lease_id) {
					await dispatchModelWorkflow(turn);
					admitted = true;
				} else if ((await turnState(session.id))?.state !== "queued")
					admitted = true;
				else await delay(2000);
			}
			if (!admitted)
				throw new Error("Turn was not admitted within two minutes.");
			let cancelled = false;
			for (;;) {
				const state = await turnState(session.id);
				const items = sessionItemsFromUnknown(state?.items);
				record.state = state?.state ?? "missing";
				const usage = items.find(
					(item) => item.kind === "userMessage",
				)?.apiUsage;
				if (usage) {
					record.inputTokens = usage.inputTokens;
					record.outputTokens = usage.outputTokens;
					record.cachedTokens = usage.cacheReadTokens;
				}
				const sent = JSON.stringify(state?.messages ?? []);
				record.memoryAttached = sent.includes(MEMORY_PART_OPEN);
				if (extraParts.length)
					record.supermemoryAttached = sent.includes("<supermemory-");
				finalItems = items;
				if (state && !["queued", "running"].includes(state.state)) break;
				if (Date.now() > started + turnTimeoutMs && !cancelled) {
					cancelled = true;
					record.errors.push(`Cancelled: exceeded ${turnTimeoutMs / 1000}s.`);
					await cancelServerTurn(userId, session.id);
				}
				if (Date.now() > started + turnTimeoutMs + 60_000) {
					record.state = "unsettled";
					break;
				}
				await delay(2000);
			}
			record.elapsedMs = Date.now() - started;
			record.supermemoryCalls = finalItems.flatMap((item) =>
				(item.kind === "mcpToolCall" && item.server === "supermemory") ||
				(item.kind === "dynamicToolCall" && /supermemory/i.test(item.tool))
					? [item.kind === "mcpToolCall" ? item.tool : item.tool]
					: [],
			);
			if (verify) {
				const result = await machines.exec(
					workspace,
					`cd '${dir}' && ${shellCommand(verify)}`,
					60_000,
				);
				verified = {
					passed: result.exitCode === 0,
					output: `${result.stdout}${result.stderr}`.trim().slice(-400),
				};
			}
		} catch (error) {
			record.errors.push(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			if (record.sessionId)
				await cancelServerTurn(userId, record.sessionId).catch(() => {});
			if (vmId) {
				const id = vmId;
				await client.vms
					.delete(id)
					.then(() => liveVms.delete(id))
					.catch(() => {});
			}
		}
		return { record, verified, items: finalItems };
	}

	/**
	 * Writes memory files before any chat, through the same Worker-side Git
	 * writer dreaming uses, with a short-lived token from wrangler.
	 */
	async function seedRepo(name: string, files: Record<string, string>) {
		const created = await run("npx", [
			"wrangler",
			"artifacts",
			"repos",
			"create",
			name,
			"--namespace",
			NAMESPACE,
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
	async function dreamNow(userId: string, after: Date) {
		await dispatchBackgroundJob({
			id: randomUUID(),
			kind: "memory",
			action: "dream",
			userId,
		});
		const deadline = Date.now() + dreamTimeoutMs;
		while (Date.now() < deadline) {
			const row = (
				await db.query<{ outcome: string }>(
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
		userId: string,
		since: Date,
	): Promise<MemoryCost[]> {
		return (
			await db.query<{
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

	async function runScenario(
		user: EvalUser,
		arm: string,
		scenario: Scenario,
		attempt: number,
	): Promise<ScenarioRecord> {
		if (arm === "supermemory")
			return runSupermemoryScenario(user, scenario, attempt);
		const started = new Date();
		const repo =
			arm === "off"
				? null
				: `memory-eval-${arm}-${scenario.id}-${randomUUID().slice(0, 8)}`;
		const result: ScenarioRecord = {
			arm,
			scenario: scenario.id,
			attempt,
			evalUser: user.asOwner ? "owner" : user.userId,
			variant: variantLabel,
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
		const project = await throwawayProject(user);
		try {
			await setEvalMemory(user, arm as "off" | "spec" | "full", repo);
			// An eval user's repos are deleted when the user is released.
			if (repo && user.asOwner) liveRepos.add(repo);
			if (arm !== "off") {
				if (repo && scenario.seed) await seedRepo(repo, scenario.seed);
				const dreams: string[] = [];
				for (const [index, setup] of setupChats(scenario).entries()) {
					const done = await chat(
						user,
						project,
						`Memory eval ${scenario.id} chat ${index + 1}`,
						setup.files,
						setup.prompt,
					);
					result.setup.push(done.record);
					// The save hook (full) is queued when the chat's turn completes.
					if (arm === "full") await delay(30_000);
					dreams.push(await dreamNow(user.userId, new Date()));
				}
				result.dream = dreams.join(",") || "none";
			}
			const second = await chat(
				user,
				project,
				`Memory eval ${scenario.id} chat 2`,
				scenario.chat2.files,
				scenario.chat2.prompt,
				scenario.verify,
			);
			result.chat2 = second.record;
			result.passed = second.verified?.passed ?? null;
			result.verifierOutput = second.verified?.output ?? "";
			// Chat 2's own save hook may still be running; let it land in the costs.
			if (arm === "full") await delay(20_000);
			result.memoryCosts = await memoryCosts(user.userId, started);
		} catch (error) {
			result.errors.push(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			await dropProject(user, project.projectId).catch(() => {});
			if (repo && user.asOwner && !flags["keep-repos"]) await deleteRepo(repo);
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
		user: EvalUser,
		scenario: Scenario,
		attempt: number,
	): Promise<ScenarioRecord> {
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
		const result: ScenarioRecord = {
			arm: "supermemory",
			scenario: scenario.id,
			attempt,
			evalUser: user.asOwner ? "owner" : user.userId,
			variant: variantLabel,
			elapsedMs: 0,
			repo: null,
			passed: null,
			verifierOutput: "",
			dream: "none",
			setup: [],
			chat2: null,
			memoryCosts: [],
			supermemory: record,
			errors: [],
		};
		const project = await throwawayProject(user);
		liveContainers.add(containerTag);
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
			await setEvalMemory(user, "off", null);
			// Seeded memory (expired-rule): the same lines as one document.
			const seeded = scenario.seed?.["MEMORY.md"];
			if (seeded)
				await ingest("seed", seeded, `seed-${randomUUID()}`, { type: "seed" });
			for (const [index, setup] of setupChats(scenario).entries()) {
				const turnStarted = new Date().toISOString();
				const done = await chat(
					user,
					project,
					`Memory eval ${scenario.id} chat ${index + 1}`,
					setup.files,
					setup.prompt,
				);
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
			const second = await chat(
				user,
				project,
				`Memory eval ${scenario.id} chat 2`,
				scenario.chat2.files,
				scenario.chat2.prompt,
				scenario.verify,
				parts,
			);
			result.chat2 = second.record;
			result.passed = second.verified?.passed ?? null;
			result.verifierOutput = second.verified?.output ?? "";
			result.memoryCosts = await memoryCosts(user.userId, started);
		} catch (error) {
			result.errors.push(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			await dropProject(user, project.projectId).catch(() => {});
			record.cleanup = await sm.deleteContainer(containerTag).then(
				(done) =>
					`deleted ${done.deletedDocumentsCount} documents, ${done.deletedMemoriesCount} memories`,
				(error: Error) => `cleanup failed: ${error.message}`,
			);
			liveContainers.delete(containerTag);
		}
		result.elapsedMs = Date.now() - started.getTime();
		console.log(
			`[supermemory] ${scenario.id}: ${result.passed === null ? "no verdict" : result.passed ? "PASS" : "fail"} (ingest ${result.dream || "none"}; injected ${record.injectedLines} lines/${record.injectedChars} chars, recalled ${record.recalled}, profile ${record.profileItems}; top hit ${record.searchHits[0]?.similarity?.toFixed(3) ?? "-"})${result.errors.length ? ` errors: ${result.errors.join("; ")}` : ""}`,
		);
		return result;
	}

	let stopping = false;
	onEvalStop(() => {
		stopping = true;
	});
	const results: ScenarioRecord[] = [];
	const started = Date.now();
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
		`Running ${jobs.length} scenario runs (${arms.join(",")} x ${scenarios.length} scenarios x ${repeat}), concurrency ${concurrency}, variant ${variantLabel}, ${owner ? "as the owner" : "one eval user per run"}.`,
	);
	const leftovers: string[] = [];
	try {
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
				while (next < jobs.length && !stopping) {
					const { arm, scenario, attempt } = jobs[next++];
					let user: EvalUser | null = owner;
					try {
						user ??= await createEvalUser({
							label: `memory-eval ${arm} ${scenario.id} #${attempt} ${variantLabel}`,
							variant,
							keepRepos: flags["keep-repos"],
						});
						results.push(await runScenario(user, arm, scenario, attempt));
					} catch (error) {
						console.error(
							`[${arm} #${attempt}] ${scenario.id}: ${error instanceof Error ? error.message : String(error)}`,
						);
					} finally {
						if (user && !user.asOwner)
							leftovers.push(...(await user.release()));
					}
				}
			}),
		);
	} finally {
		for (const id of liveVms) await client.vms.delete(id).catch(() => {});
		for (const id of liveProjects)
			if (owner) await dropProject(owner, id).catch(() => {});
		for (const tag of liveContainers)
			await sm?.deleteContainer(tag).catch(() => {});
		if (!flags["keep-repos"])
			for (const name of liveRepos) await deleteRepo(name);
		if (owner) {
			if (savedSettings)
				await db.query(
					"update user_memory set mode=$2,repo=$3,dreamed_through=$4,updated_at=now() where user_id=$1",
					[
						owner.userId,
						savedSettings.mode,
						savedSettings.repo,
						savedSettings.dreamed_through,
					],
				);
			else
				await db.query("delete from user_memory where user_id=$1", [
					owner.userId,
				]);
		}
		await closeDatabase();
	}
	if (leftovers.length) {
		console.error(`Cleanup incomplete: ${leftovers.join(", ")}.`);
		process.exitCode = 1;
	}

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
	for (const arm of arms) {
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
		`\nModel ${model} (${effort}); variant ${variantLabel}; total ${Math.round((Date.now() - started) / 1000)}s. Chat token columns are chat 2's agent turns; save and dream columns are memory jobs on the user's route.`,
	);
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
