import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	AGENT_SEND_TOOL,
	AGENT_TOOL,
	liveChildrenAllowed,
	SUBAGENT_BRIEF_MAX,
	SUBAGENT_TITLE_MAX,
} from "../../src/domain/subagent";
import { capText } from "../../src/server/services/tool-output-cap";
import { LEAD_REPORT_MAX_CHARS } from "./children";
import type { HarborModel } from "./config";
import type { ChildReport, ChildSession, TrialSessions } from "./sessions";

/**
 * helpers=on inside a Harbor trial: the root builder's read-only subagents,
 * on the in-memory session store instead of the product's agent_sessions
 * and mailboxes.
 *
 * - `agent` starts a researcher or reviewer (the product's tool name and
 *   input; writers and checkers are refused: the builder stays the trial's
 *   only writer). It runs in the background on its own copy of the
 *   checkout, on the builder's model, unless `wait` blocks for its report.
 * - The product delivers a reader's report as a message; a trial has no
 *   mailbox, so `agent_wait` collects reports instead (one id, or every
 *   report not yet collected), waiting up to 10 minutes.
 * - `agent_send` stops a running helper, or briefs a finished one again
 *   (it keeps its context), as the product's does.
 * - Helpers still running when the builder finishes are stopped by the
 *   trial, like every child session.
 */

export const AGENT_WAIT_TOOL = "agent_wait";
export const HELPER_ROLES = ["researcher", "reviewer"] as const;
export type HelperRole = (typeof HELPER_ROLES)[number];
/** As many live helpers as the product lets a builder run children. */
export const MAX_LIVE_HELPERS = liveChildrenAllowed(0);
const MAX_WAIT_MS = 10 * 60_000;

/** Runs one round of a helper on its own read-only copy; resolves with its report. */
export type StartHelper = (
	session: ChildSession,
	role: HelperRole,
	brief: string,
) => Promise<ChildReport>;

type Helper = {
	session: ChildSession;
	role: HelperRole;
	title: string;
	running: Promise<ChildReport> | null;
	/** The latest report not yet returned to the builder. */
	pending: ChildReport | null;
};

const agentInput = z.object({
	role: z
		.enum(HELPER_ROLES)
		.describe(
			"researcher: reads, searches and runs commands to answer a question; reviewer: inspects your current work and reports problems. Both are read-only.",
		),
	title: z
		.string()
		.min(1)
		.max(SUBAGENT_TITLE_MAX)
		.describe('Its task in a few plain words, e.g. "Find the config loader"'),
	brief: z
		.string()
		.min(1)
		.max(SUBAGENT_BRIEF_MAX)
		.describe(
			"Self-contained: goal, context (paths, findings, working commands), constraints, report format",
		),
	wait: z
		.boolean()
		.optional()
		.describe(
			"Block until its report (default false: keep working and collect it with agent_wait)",
		),
});

function reportText(helper: Helper, report: ChildReport) {
	const head = report.budgetUsed
		? `Agent ${helper.session.id} (${helper.role}) stopped: budget used (${report.budgetUsed}).${report.report ? " Its last message:" : ""}`
		: `Agent ${helper.session.id} (${helper.role}) ${report.outcome === "completed" ? "reported" : "failed"}:`;
	return `${head}\n${capText(report.report || "(no report)", LEAD_REPORT_MAX_CHARS, "brief it again for the part you need")}`;
}

export function helperTools(input: {
	parentId: string;
	sessions: TrialSessions;
	model: HarborModel;
	start: StartHelper;
	log?: (line: string) => void;
}): ToolSet {
	const helpers = new Map<string, Helper>();
	const live = () =>
		[...helpers.values()].filter((helper) => helper.running).length;

	const launch = (helper: Helper, brief: string) => {
		helper.pending = null;
		const running = input
			.start(helper.session, helper.role, brief)
			.catch((): ChildReport => ({ outcome: "failed", report: "" }))
			.then((report) => {
				helper.running = null;
				helper.pending = report;
				input.log?.(
					`helper ${helper.session.id} ${report.outcome}${report.budgetUsed ? ` (${report.budgetUsed})` : ""}`,
				);
				return report;
			});
		helper.running = running;
		return running;
	};

	/** Waits for each helper (or the deadline) and returns its report once. */
	const collect = async (targets: Helper[]) => {
		const deadline = new Promise<"timeout">((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), MAX_WAIT_MS);
			timer.unref?.();
		});
		await Promise.race([
			Promise.all(targets.map((helper) => helper.running)),
			deadline,
		]);
		return targets.map((helper) => {
			if (helper.running)
				return `Agent ${helper.session.id} (${helper.role}) is still running; wait again or stop it.`;
			const report = helper.pending;
			helper.pending = null;
			return report ? reportText(helper, report) : "";
		});
	};

	const yours = () =>
		[...helpers.values()]
			.map(
				(helper) =>
					`${helper.session.id} (${helper.role}, ${helper.running ? "running" : helper.pending ? "report ready" : "idle"})`,
			)
			.join(", ") || "none";

	return {
		[AGENT_TOOL]: tool({
			description:
				"Start a read-only helper (researcher or reviewer) in the background on its own copy of your checkout. It sees only your brief (never this conversation), cannot change your files, and reports back; keep working and collect the report with agent_wait, or pass wait: true. Returns its id.",
			inputSchema: agentInput,
			execute: async ({ role, title, brief, wait }) => {
				if (live() >= MAX_LIVE_HELPERS)
					return `Refused: ${MAX_LIVE_HELPERS} helpers are already running; collect or stop one first, or do the work yourself.`;
				const session = input.sessions.add({
					role: "helper",
					parentId: input.parentId,
					model: input.model,
					brief,
				});
				const helper: Helper = {
					session,
					role,
					title,
					running: null,
					pending: null,
				};
				helpers.set(session.id, helper);
				input.log?.(`helper ${session.id} (${role}) started: ${title}`);
				const running = launch(helper, brief);
				if (!wait)
					return `Started agent ${session.id} (${role}): ${title}. Collect its report with agent_wait.`;
				await running;
				return (await collect([helper])).join("\n\n");
			},
		}),
		[AGENT_WAIT_TOOL]: tool({
			description:
				"Wait for your helpers' reports: one id, or every report not yet collected. Returns each report once.",
			inputSchema: z.object({
				id: z
					.string()
					.max(20)
					.optional()
					.describe('One helper\'s id, e.g. "trial.1"; omit for all'),
			}),
			execute: async ({ id }) => {
				if (id) {
					const helper = helpers.get(id);
					if (!helper)
						return `No agent ${id} of yours. Your agents: ${yours()}.`;
					if (!helper.running && !helper.pending)
						return `Agent ${id} has no new report; brief it again with agent_send.`;
					return (await collect([helper])).join("\n\n");
				}
				const targets = [...helpers.values()].filter(
					(helper) => helper.running || helper.pending,
				);
				if (!targets.length)
					return `No reports to collect. Your agents: ${yours()}.`;
				return (await collect(targets)).filter(Boolean).join("\n\n");
			},
		}),
		[AGENT_SEND_TOOL]: tool({
			description:
				"Stop a running helper (it reports what it has), or brief a finished helper again (it keeps its context); collect the report with agent_wait.",
			inputSchema: z.object({
				id: z.string().min(1).max(20).describe('The agent id, e.g. "trial.1"'),
				message: z
					.string()
					.min(1)
					.max(8_000)
					.optional()
					.describe("A new brief for a finished helper"),
				stop: z.boolean().optional().describe("Wrap up now"),
			}),
			execute: async ({ id, message, stop }) => {
				const helper = helpers.get(id);
				if (!helper) return `No agent ${id} of yours. Your agents: ${yours()}.`;
				if (stop) {
					helper.session.stop();
					return `Agent ${id} stopped; collect what it reported with agent_wait.`;
				}
				if (!message?.trim()) return "Pass a message, stop: true, or both.";
				if (helper.running)
					return `Agent ${id} is still running; collect its report with agent_wait or stop it first.`;
				if (live() >= MAX_LIVE_HELPERS)
					return `Refused: ${MAX_LIVE_HELPERS} helpers are already running.`;
				launch(helper, message);
				return `Agent ${id} briefed again. Collect its report with agent_wait.`;
			},
		}),
	};
}
