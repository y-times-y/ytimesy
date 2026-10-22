import { type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { ApiTokenUsage } from "../../src/domain/api-token-usage";
import {
	CHECKER_WORKER_TOOL,
	checkerWorkerBrief,
	MAX_LIVE_CHECKER_WORKERS,
} from "../../src/domain/checker-pair";
import { usageCostUsd } from "../../src/domain/model-pricing";
import {
	harnessExplorationBrief,
	SIDEKICK_MAX_RESTARTS,
	sidekickHandoffBrief,
} from "../../src/domain/sidekick";
import {
	applicableDecision,
	CLASSIFIER_INSTRUCTIONS,
	classifierMessage,
	parseClassifierReply,
	rulesDecision,
	type SidekickDecisionRecord,
	sidekickDecisionNotice,
} from "../../src/domain/sidekick-classifier";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "../../src/domain/subagent";
import { usageTokens } from "../../src/domain/subagent-usage";
import { capText } from "../../src/server/services/tool-output-cap";
import type { BridgeRole, HarborModel } from "./config";
import type { ChildReport, ChildSession, TrialSessions } from "./sessions";

/**
 * lead=fusion and checkerMode=pair inside a Harbor trial, on the in-memory
 * session store (sessions.ts) instead of the product's agent_sessions,
 * mailboxes and VM forks:
 *
 * - One writer at a time, in the lead's own checkout: the lead's
 *   `agent` (role writer) / `agent_send` call runs the sidekick's round in
 *   process and returns its report, so the lead makes no model call while
 *   the sidekick works (the product's fusionLeadGate wait, without polling).
 *   One sidekick per trial; any other role or a second writer is refused
 *   ("A refused spawn means do the work yourself").
 * - Each round ends with the product's classifier (its prompt, parser and
 *   rules fallback) on roleModels.classifier; a hand_back or switch_model
 *   decision adds the product's runtime notice to the report, and
 *   switch_model moves the sidekick to roleModels.writerEscalation for its
 *   next round (the product switches at its next compaction).
 * - A pair judge's checker_worker starts read-only workers (the product's
 *   worker brief frame) and waits for their reports.
 */

/** Runs one round of a child session and resolves with its report. */
export type RunRound = (
	session: ChildSession,
	brief: string,
	options: {
		readOnly: boolean;
		extraTools?: (tools: ToolSet) => ToolSet;
		/** A reader's own copy of the checkout (default: the lead's checkout). */
		cwd?: string;
	},
) => Promise<ChildReport>;

/** One tool-free model call (the classifier), its text. */
export type CallOnce = (
	session: ChildSession,
	instructions: string,
	message: string,
) => Promise<{ text: string; usage: ApiTokenUsage | null }>;

export type FusionTrace = {
	decisions: SidekickDecisionRecord[];
	rounds: {
		sessionId: string;
		n: number;
		kind: "explore" | "build";
		outcome: string;
	}[];
	refused: string[];
	/** Fresh sidekicks started with a handoff after a failed one (leadTools=thin). */
	restarts: { from: string; to: string; reason: string }[];
};

/** The most characters of a round's report the lead reads (its context stays small). */
export const LEAD_REPORT_MAX_CHARS = 12_000;

/** Why a round counts as failed for a restart, or null when it delivered a report. */
function roundFailure(report: ChildReport) {
	if (report.budgetUsed) return `budget used: ${report.budgetUsed}`;
	if (report.outcome !== "completed") return "it failed";
	const text = report.report.trim();
	// Degenerate output: nothing, or one character repeated.
	if (!text || /^(.)\1*$/s.test(text))
		return "its output was empty or degenerate";
	return null;
}

export function fusionLead(input: {
	parentId: string;
	sessions: TrialSessions;
	model: (role: BridgeRole) => HarborModel;
	escalation: HarborModel | null;
	runRound: RunRound;
	callOnce: CallOnce;
	/** `git status --short` of the checkout, for the round's report and the classifier. */
	changedFiles: () => Promise<string[]>;
	trace: FusionTrace;
	/** leadTools=thin: the lead cannot take over, so failures point it to a restart. */
	thin?: boolean;
	now?: () => number;
}) {
	const now = input.now ?? Date.now;
	let sidekick: ChildSession | null = null;
	let switchedTo: string | null = null;
	let lastFailure: string | null = null;
	const restartsLeft = () =>
		SIDEKICK_MAX_RESTARTS - input.trace.restarts.length;

	async function round(brief: string, kind: "explore" | "build") {
		const session = sidekick as ChildSession;
		const n = session.reports.length + 1;
		if (switchedTo && input.escalation) {
			session.model = input.escalation;
			switchedTo = null;
		}
		const report = await input.runRound(session, brief, { readOnly: false });
		const files = await input.changedFiles().catch(() => []);
		// The product's round outcomes: a round stopped at its budget is not a failure.
		const outcome =
			report.outcome === "completed"
				? ("finished" as const)
				: report.budgetUsed
					? ("budget exhausted" as const)
					: ("failed" as const);
		input.trace.rounds.push({
			sessionId: session.id,
			n,
			kind,
			outcome,
		});
		const canSwitch = !!input.escalation;
		const summary = {
			point: "round" as const,
			round: n,
			roundKind: kind === "explore" ? ("explore" as const) : ("build" as const),
			model: session.model.modelId,
			brief,
			report: report.report,
			commands: [],
			diff: { files, added: 0, removed: 0 },
			outcome,
			signals: [],
			canSwitch,
		} as Parameters<typeof classifierMessage>[0];
		const classifier = input.sessions.add({
			role: "classifier",
			parentId: session.id,
			model: input.model("classifier"),
		});
		const started = now();
		let source: "classifier" | "rules" = "rules";
		let fallback: string | undefined;
		let answer = rulesDecision([], canSwitch);
		let usage: ApiTokenUsage | null = null;
		try {
			const reply = await input.callOnce(
				classifier,
				CLASSIFIER_INSTRUCTIONS,
				classifierMessage(summary),
			);
			usage = reply.usage;
			const text = reply.text;
			const parsed = parseClassifierReply(text);
			if (parsed) {
				answer = applicableDecision(parsed, canSwitch);
				source = "classifier";
			} else
				fallback = `unparsable reply: ${text.trim().slice(0, 120) || "(empty)"}`;
		} catch (error) {
			fallback = `failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`;
		}
		input.trace.decisions.push({
			point: "round",
			round: n,
			decision: answer.decision,
			reason: answer.reason,
			source,
			...(fallback ? { fallback } : {}),
			inputsHash: "",
			latencyMs: Math.max(0, now() - started),
			tokens: usageTokens(usage),
			costUsd: usageCostUsd(usage, classifier.model.billing) ?? 0,
			planBilled: classifier.model.billing.kind === "plan",
			model: classifier.model.modelId,
			at: new Date(now()).toISOString(),
		} as SidekickDecisionRecord);
		if (answer.decision === "switch_model" && input.escalation)
			switchedTo = input.escalation.modelId;
		lastFailure = roundFailure(report);
		const notice = sidekickDecisionNotice({
			label: session.id,
			decision: answer.decision,
			reason: answer.reason,
			thin: input.thin,
			...(answer.decision === "switch_model" && input.escalation
				? { switchTo: input.escalation.modelId }
				: {}),
		});
		return [
			report.budgetUsed
				? `Sidekick ${session.id} round ${n} (${kind}) stopped: sidekick budget used (${report.budgetUsed}). Its edits so far are in your checkout; ${report.report ? "its last message:" : "it wrote no report."}`
				: `Sidekick ${session.id} round ${n} (${kind}) ${report.outcome === "completed" ? "reported" : "failed"}:`,
			capText(
				report.budgetUsed ? report.report : report.report || "(no report)",
				LEAD_REPORT_MAX_CHARS,
				"ask your writer for the part you need",
			),
			files.length
				? `Changed files in your checkout now:\n${files.join("\n")}`
				: "",
			notice,
			input.thin && lastFailure
				? restartsLeft() > 0
					? `Runtime notice: this round failed (${lastFailure}). Re-brief your writer more narrowly, or restart it: ${AGENT_SEND_TOOL} with id ${session.id}, restart: true and your brief (a fresh writer gets a handoff; ${restartsLeft()} restart(s) left).`
					: `Runtime notice: this round failed (${lastFailure}) and no restarts are left. Re-brief your writer narrowly, or finish and report what is blocked.`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
	}

	function start() {
		sidekick = input.sessions.add({
			role: "sidekick",
			parentId: input.parentId,
			model: input.model("writer"),
		});
		return sidekick;
	}

	const refuse = (why: string) => {
		input.trace.refused.push(why);
		return `Refused: ${why} ${input.thin ? "Brief your writer instead." : "Do the work yourself."}`;
	};

	/** A fresh sidekick in place of the current one, briefed with a handoff. */
	async function restart(message: string) {
		const previous = sidekick as ChildSession;
		previous.stop();
		const files = await input.changedFiles().catch(() => []);
		const reason = lastFailure ?? "restarted by Main";
		const next = start();
		input.trace.restarts.push({ from: previous.id, to: next.id, reason });
		return round(
			sidekickHandoffBrief({
				previous: previous.id,
				reason,
				lastBrief: previous.briefs.at(-1),
				lastReport: previous.reports.at(-1)?.report,
				changes: files.join("\n"),
				message,
			}),
			"build",
		);
	}

	return {
		/** The harness's exploration round for the request, before the lead's first model call. */
		explore: async (request: string) => {
			start();
			return round(harnessExplorationBrief(request), "explore");
		},
		tools: (): ToolSet => ({
			[AGENT_TOOL]: tool({
				description:
					"Start your sidekick (role writer): it works in your checkout while you wait, and its report is this call's result. Other roles are not available here.",
				inputSchema: z.object({
					role: z.string(),
					title: z.string().optional(),
					brief: z.string().max(20_000).optional(),
					explore: z.boolean().optional(),
				}),
				execute: async ({ role, brief, explore }) => {
					if (role !== "writer")
						return refuse(
							`role ${role} needs the product's subagents; this run has only your sidekick (role writer).`,
						);
					if (sidekick)
						return refuse(
							`one writer at a time: your sidekick ${sidekick.id} already exists; send it the brief with ${AGENT_SEND_TOOL}${input.thin ? " (restart: true replaces it with a fresh one)" : ""}.`,
						);
					if (!brief?.trim()) return refuse("a writer needs a brief.");
					start();
					return round(brief, explore ? "explore" : "build");
				},
			}),
			[AGENT_SEND_TOOL]: tool({
				description: input.thin
					? "Send your sidekick its next brief or feedback (a new round, its report is this call's result), stop it, or restart it (restart: true: a fresh sidekick gets a handoff and your message)."
					: "Send your sidekick its next brief or feedback (a new round, its report is this call's result), or stop it.",
				inputSchema: z.object({
					id: z.string(),
					message: z.string().max(8_000).optional(),
					stop: z.boolean().optional(),
					explore: z.boolean().optional(),
					...(input.thin ? { restart: z.boolean().optional() } : {}),
				}),
				execute: async ({ id, message, stop, explore, ...rest }) => {
					if (!sidekick || sidekick.id !== id)
						return refuse(`no sidekick ${id}.`);
					if (stop) {
						sidekick.stop();
						return `Sidekick ${id} stopped.`;
					}
					if (!message?.trim()) return refuse("send needs a message.");
					if ((rest as { restart?: boolean }).restart) {
						if (restartsLeft() <= 0)
							return refuse(
								`all ${SIDEKICK_MAX_RESTARTS} restarts are used; re-brief sidekick ${id} narrowly, or finish and report what is blocked.`,
							);
						return restart(message);
					}
					return round(message, explore ? "explore" : "build");
				},
			}),
		}),
	};
}

/** A pair judge's checker_worker: read-only workers on roleModels.checkerWorker. */
export function checkerWorkerTool(input: {
	judge: ChildSession;
	sessions: TrialSessions;
	model: (strong: boolean) => HarborModel;
	runRound: RunRound;
}): ToolSet {
	const run = async (
		brief: string,
		strong: boolean,
		id: string | undefined,
	) => {
		const worker = id
			? input.sessions.get(id)
			: input.sessions.add({
					role: "checkerWorker",
					parentId: input.judge.id,
					model: input.model(strong),
				});
		if (!worker || worker.parentId !== input.judge.id)
			return `Worker ${id}: not one of yours.`;
		const report = await input.runRound(worker, checkerWorkerBrief(brief), {
			readOnly: true,
		});
		return report.budgetUsed
			? `Worker ${worker.id} stopped: checker worker budget used (${report.budgetUsed}).${report.report ? ` Its last message:\n${report.report}` : ""}`
			: `Worker ${worker.id} ${report.outcome}:\n${report.report || "(no report)"}`;
	};
	return {
		[CHECKER_WORKER_TOOL]: tool({
			description:
				"Brief a read-only worker (or several at once) and wait for their evidence.",
			inputSchema: z.object({
				brief: z.string().max(10_000).optional(),
				title: z.string().optional(),
				model: z.enum(["cheap", "strong"]).optional(),
				workers: z
					.array(
						z.object({
							brief: z.string().max(10_000),
							title: z.string().optional(),
							model: z.enum(["cheap", "strong"]).optional(),
						}),
					)
					.min(1)
					.max(MAX_LIVE_CHECKER_WORKERS)
					.optional(),
				id: z.string().optional(),
			}),
			execute: async ({ brief, model, workers, id }) => {
				if (workers?.length)
					return (
						await Promise.all(
							workers.map((worker) =>
								run(worker.brief, worker.model === "strong", undefined),
							),
						)
					).join("\n\n");
				if (!brief?.trim()) return "Refused: a worker needs a brief.";
				return run(brief, model === "strong", id);
			},
		}),
	};
}

/** The messages a child round runs on: its history, then the brief. */
export function roundMessages(
	session: ChildSession,
	brief: string,
): ModelMessage[] {
	return [...session.messages, { role: "user", content: brief }];
}
