// Sample selection for the checker detection test (docs/checker-detect.md).
// Pure: it sees only trial metadata (reward, artifact manifest, which grader
// files exist) and task facts, never a checker's output, and orders by a
// salted hash so the choice is fixed before any checker runs.
import { createHash } from "node:crypto";

export type TrialArtifact = {
	/** The task's artifact path (task.toml `artifacts`). */
	readonly source: string;
	/** Compose service it was copied from ("main" for the task container). */
	readonly service: string;
	/** Harbor's manifest status (ok, empty, failed). */
	readonly status: string;
	/** Bytes saved for it (0 when nothing was saved). */
	readonly bytes: number;
};

export type TrialSummary = {
	readonly task: string;
	readonly trial: string;
	/** Directory of the trial in the extracted backup. */
	readonly path: string;
	readonly reward: number | null;
	/** Counted by the official TB4 scorer (agent started, graded, model called). */
	readonly scored: boolean;
	/** The task's own artifacts (Harbor's /logs/artifacts entry left out). */
	readonly artifacts: readonly TrialArtifact[];
	/** Non-empty grader output files besides the bare reward (test-stdout, ctrf, details). */
	readonly evidenceFiles: readonly string[];
};

export type TaskFacts = {
	readonly id: string;
	readonly gpus: number;
	readonly mcpServers: number;
	readonly cpus: number;
	readonly memoryMb: number;
	/** A compose service builds its image (the runner needs pinned images). */
	readonly buildsImage: boolean;
	readonly hasSidecars: boolean;
};

export type SampleKind = "failing" | "held-out" | "control";

export type Sample = {
	/** `<task>.<trial id>`: stable, used for run records. */
	readonly id: string;
	readonly kind: SampleKind;
	readonly task: string;
	readonly trial: string;
	readonly path: string;
	readonly reward: number;
	/** Caveats that may limit what a checker can see (reported with the result). */
	readonly caveats: readonly string[];
};

export type Selection = {
	readonly rule: string;
	readonly samples: readonly Sample[];
	readonly excludedTasks: readonly { task: string; reason: string }[];
};

/** Tasks the public Codex job always passed and the brief's failure analysis never used. */
export const HELD_OUT_TASKS = [
	"heat-pump-warranty",
	"legacy-utility-triage",
	"mvcc-lsm-compaction",
] as const;

export const SELECTION_RULE = {
	salt: "checker-detect-v1",
	failing: 20,
	controls: 8,
	/** Freestyle caps a VM at 8 vCPUs; the runner gives memory + 2 GB up to 16 GB. */
	maxCpus: 8,
	maxMemoryMb: 16384,
	/** The reference solution fails in the task's own image on our runner (docs/hard-set.md). */
	brokenEnvironment: ["cad-model"],
	/** Deliverables only reachable through a GUI the harness cannot drive, or task MCP servers. */
	sidecarStateCaveat:
		"deliverable lives in a service sidecar: restored as the file the grader read; the service may not reload it",
} as const;

const RULE_TEXT = `Pre-registered (${SELECTION_RULE.salt}), before any checker output: scored trials only (official TB4 scorer). A task is eligible when it needs no GPU, no task MCP server, at most ${SELECTION_RULE.maxCpus} CPUs and ${SELECTION_RULE.maxMemoryMb / 1024} GB, builds no image and its environment is not known broken (${SELECTION_RULE.brokenEnvironment.join(", ")}). A trial is usable when every task artifact was saved non-empty (status ok) and, for a failing trial, the grader left output beyond the bare reward. Held-out tasks (${HELD_OUT_TASKS.join(", ")}): every usable failing trial. Other failing samples: tasks ordered by sha256(salt:task), one trial each (lowest sha256(salt:trial)), up to ${SELECTION_RULE.failing} failing samples in all. Controls: ${SELECTION_RULE.controls} passing trials (reward 1) of other eligible tasks, same ordering.`;

export const rank = (value: string) =>
	createHash("sha256").update(`${SELECTION_RULE.salt}:${value}`).digest("hex");

const byRank =
	<T>(key: (item: T) => string) =>
	(a: T, b: T) =>
		rank(key(a)).localeCompare(rank(key(b)));

export function taskExclusion(task: TaskFacts | undefined): string | null {
	if (!task) return "no task definition";
	if (task.gpus > 0) return "needs a GPU";
	if (task.mcpServers > 0) return "needs task MCP servers";
	if (task.cpus > SELECTION_RULE.maxCpus)
		return `needs ${task.cpus} CPUs (VM cap ${SELECTION_RULE.maxCpus})`;
	if (task.memoryMb > SELECTION_RULE.maxMemoryMb)
		return `needs ${task.memoryMb} MB`;
	if (task.buildsImage) return "a service builds its image";
	if ((SELECTION_RULE.brokenEnvironment as readonly string[]).includes(task.id))
		return "reference solution fails in its own image on our runner";
	return null;
}

/** Why a trial's saved workspace cannot stand for its final state (null when usable). */
export function workspaceProblem(trial: TrialSummary): string | null {
	if (!trial.artifacts.length) return "no task artifacts";
	const bad = trial.artifacts.filter(
		(artifact) => artifact.status !== "ok" || artifact.bytes <= 0,
	);
	return bad.length
		? `artifacts not saved: ${bad.map((artifact) => `${artifact.source} (${artifact.status}, ${artifact.bytes} B)`).join(", ")}`
		: null;
}

function caveatsFor(trial: TrialSummary, task: TaskFacts) {
	const caveats: string[] = [];
	if (trial.artifacts.some((artifact) => artifact.service !== "main"))
		caveats.push(SELECTION_RULE.sidecarStateCaveat);
	else if (task.hasSidecars)
		caveats.push("service sidecars start fresh (their state is not restored)");
	return caveats;
}

export function selectSamples(
	trials: readonly TrialSummary[],
	tasks: readonly TaskFacts[],
): Selection {
	const facts = new Map(tasks.map((task) => [task.id, task]));
	const taskIds = [...new Set(trials.map((trial) => trial.task))].sort();
	const excludedTasks: { task: string; reason: string }[] = [];
	const eligible = new Set<string>();
	for (const id of taskIds) {
		const reason = taskExclusion(facts.get(id));
		if (reason) excludedTasks.push({ task: id, reason });
		else eligible.add(id);
	}
	const scored = trials.filter(
		(trial) =>
			trial.scored && trial.reward !== null && eligible.has(trial.task),
	);
	const usableFailing = scored.filter(
		(trial) =>
			(trial.reward as number) < 1 &&
			!workspaceProblem(trial) &&
			trial.evidenceFiles.length > 0,
	);
	const usablePassing = scored.filter(
		(trial) => trial.reward === 1 && !workspaceProblem(trial),
	);
	const sample = (trial: TrialSummary, kind: SampleKind): Sample => ({
		id: `${trial.task}.${trial.trial.split("__").at(-1)}`,
		kind,
		task: trial.task,
		trial: trial.trial,
		path: trial.path,
		reward: trial.reward as number,
		caveats: caveatsFor(trial, facts.get(trial.task) as TaskFacts),
	});
	const heldOut = usableFailing
		.filter((trial) =>
			(HELD_OUT_TASKS as readonly string[]).includes(trial.task),
		)
		.sort(byRank((trial) => trial.trial))
		.map((trial) => sample(trial, "held-out"));
	for (const task of HELD_OUT_TASKS)
		if (!heldOut.some((entry) => entry.task === task))
			excludedTasks.push({
				task,
				reason: eligible.has(task)
					? "held-out task without a usable failing trial"
					: (excludedTasks.find((entry) => entry.task === task)?.reason ??
						"not in the backup"),
			});
	const failingTasks = [...new Set(usableFailing.map((trial) => trial.task))]
		.filter((task) => !(HELD_OUT_TASKS as readonly string[]).includes(task))
		.sort(byRank((task) => task))
		.slice(0, Math.max(0, SELECTION_RULE.failing - heldOut.length));
	const failing = failingTasks.map((task) =>
		sample(
			usableFailing
				.filter((trial) => trial.task === task)
				.sort(byRank((trial) => trial.trial))[0],
			"failing",
		),
	);
	const used = new Set([...heldOut, ...failing].map((entry) => entry.task));
	const controls = [...new Set(usablePassing.map((trial) => trial.task))]
		.filter(
			(task) =>
				!used.has(task) &&
				!(HELD_OUT_TASKS as readonly string[]).includes(task),
		)
		.sort(byRank((task) => task))
		.slice(0, SELECTION_RULE.controls)
		.map((task) =>
			sample(
				usablePassing
					.filter((trial) => trial.task === task)
					.sort(byRank((trial) => trial.trial))[0],
				"control",
			),
		);
	return {
		rule: RULE_TEXT,
		samples: [...heldOut, ...failing, ...controls],
		excludedTasks,
	};
}
