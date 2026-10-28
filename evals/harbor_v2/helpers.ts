import { posix } from "node:path";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import {
	AGENT_SEND_TOOL,
	AGENT_TOOL,
	liveChildrenAllowed,
	SUBAGENT_BRIEF_MAX,
	SUBAGENT_TITLE_MAX,
} from "../../src/domain/subagent";
import { WRITER_PATCH_INTEGRATION } from "../../src/domain/writer-integration";
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
 *   input; checkers are refused). It runs in the background on its own
 *   copy of the checkout, on the builder's model, unless `wait` blocks for
 *   its report. helpers=write also allows a writer: it works in the
 *   builder's own checkout and may change only the paths in `owns`
 *   (ownership by brief, as Reason Agent's subagents; no file locking).
 *   helpers=write-tree runs each writer on its own git worktree instead
 *   (worktree-writers.ts): no `owns`; its report carries a patch and git
 *   ref the builder applies with `git apply -3`, as the product's writer.
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
/** helpers=write adds a writer in the builder's own checkout. */
export const WRITE_HELPER_ROLES = [...HELPER_ROLES, "writer"] as const;
export type HelperRole = (typeof WRITE_HELPER_ROLES)[number];
/** As many live helpers as the product lets a builder run children. */
/**
 * The builder's prompt section for helpers=on, in place of the product's
 * orchestrator section: helpers here are read-only, their reports are
 * collected with agent_wait (no mailbox), and every helper is paid for, so
 * the bar is cost, not wall-clock time alone.
 */
export const HELPER_INSTRUCTIONS = [
	"Helpers: `agent` starts a read-only helper (researcher or reviewer) in the background on its own copy of your checkout, with only your brief, and returns its id at once. `agent_wait` collects reports; `agent_send` stops a helper or briefs a finished one again.",
	"A helper costs about as much as you do and re-reads what it needs. Start one only for an independent investigation likely to take over 10 minutes, while you have other work to do meanwhile. Small, quick or sequential work, or anything you would finish in a few steps, you do yourself.",
	"Every brief is self-contained: the goal, the paths and findings it needs, constraints and the report format.",
	"Keep working while helpers run. Once you have what you need, stop running helpers with agent_send instead of waiting for them.",
	"A report is a claim: spot-check it before relying on it. A refused start means do the work yourself.",
].join("\n");

/**
 * helpers=write's section: the read-only helpers' rules plus writers in the
 * builder's own checkout, decided once, right after reading the task, for
 * long work that splits into independent parts, each with its own files.
 */
export const WRITE_HELPER_INSTRUCTIONS = [
	"Helpers: `agent` starts a helper in the background with only your brief and returns its id at once: a researcher or reviewer (read-only, on its own copy of your checkout) or a writer (in your own checkout, changing only the paths you list in `owns`). `agent_wait` collects reports; `agent_send` stops a helper or briefs a finished one again.",
	"Writers: decide once, after your first look at the task and its files, and never later. Start writers only when the work splits into two or more parts that can be built and checked separately and each part is a large job on its own (hours of work or thousands of lines). Give each writer its own files or directories, never ones another agent changes, and state the interfaces between the parts in the briefs. While they work, do your own part in other files; then integrate their parts and run the final checks yourself. Otherwise do all the work yourself.",
	...HELPER_INSTRUCTIONS.split("\n").slice(1),
].join("\n");

export const MAX_LIVE_HELPERS = liveChildrenAllowed(0);
const MAX_WAIT_MS = 10 * 60_000;

/**
 * helpers=write-tree's section: helpers=write's policy lines with the
 * product's writer mechanic. Only the mechanics differ: the first line
 * (where a writer works) and the product's integration sentence, shared
 * with the product (writer-integration.ts), never a paraphrase.
 */
export const WORKTREE_WRITER_INSTRUCTIONS = [
	"Helpers: `agent` starts a helper in the background with only your brief and returns its id at once: a researcher or reviewer (read-only, on its own copy of your checkout) or a writer (on its own git worktree of your checkout, your uncommitted work included; its report gives its work as a patch and a git ref). `agent_wait` collects reports; `agent_send` stops a helper or briefs a finished one again.",
	...WRITE_HELPER_INSTRUCTIONS.split("\n").slice(1),
	WRITER_PATCH_INTEGRATION,
].join("\n");

/** Where a writer works: the builder's checkout (helpers=write) or its own worktree (write-tree). */
export type WriterMode = "shared" | "worktree";

/**
 * Runs one round of a helper: a reader on its own read-only copy, a writer
 * in the builder's checkout limited to `owns`; resolves with its report.
 */
export type StartHelper = (
	session: ChildSession,
	role: HelperRole,
	brief: string,
	owns?: readonly string[],
) => Promise<ChildReport>;

type Helper = {
	session: ChildSession;
	role: HelperRole;
	title: string;
	owns?: readonly string[];
	running: Promise<ChildReport> | null;
	/** The latest report not yet returned to the builder. */
	pending: ChildReport | null;
};

const READER_ROLES_TEXT =
	"researcher: reads, searches and runs commands to answer a question; reviewer: inspects your current work and reports problems. Both are read-only.";

const agentInput = (writers: WriterMode | null) =>
	z.object({
		role: writers
			? z
					.enum(WRITE_HELPER_ROLES)
					.describe(
						writers === "worktree"
							? `${READER_ROLES_TEXT} writer: implements its part on its own git worktree of your checkout and returns a patch and git ref.`
							: `${READER_ROLES_TEXT} writer: implements its part in your checkout, changing only the paths in owns.`,
					)
			: z.enum(HELPER_ROLES).describe(READER_ROLES_TEXT),
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
		...(writers === "shared"
			? {
					owns: z
						.array(z.string().min(1).max(300))
						.max(40)
						.optional()
						.describe(
							"writer only, required: the files or directories it may create or change; nothing another agent changes",
						),
				}
			: {}),
		wait: z
			.boolean()
			.optional()
			.describe(
				"Block until its report (default false: keep working and collect it with agent_wait)",
			),
	});

/**
 * The file paths a writer's write and edit calls touched outside its `owns`
 * (direct calls, and literal paths in run_code's tools.write/edit calls).
 * For the log only: bash writes are not seen, and nothing is blocked.
 */
export function writesOutside(
	events: readonly ApiAgentEvent[],
	cwd: string,
	owns: readonly string[],
) {
	const absolute = (path: string) =>
		posix.normalize(path.startsWith("/") ? path : posix.join(cwd, path));
	const owned = owns.map(absolute);
	const paths: string[] = [];
	for (const event of events) {
		if (event.type !== "tool-call") continue;
		const input = event.input as { path?: unknown; code?: unknown } | null;
		if (WRITE_TOOLS.has(event.name) && typeof input?.path === "string")
			paths.push(input.path);
		if (typeof input?.code === "string")
			for (const match of input.code.matchAll(
				/tools\.(?:write|edit)\(\s*\{\s*path\s*:\s*["'`]([^"'`]+)["'`]/g,
			))
				paths.push(match[1] as string);
	}
	return [
		...new Set(
			paths
				.map(absolute)
				.filter(
					(path) =>
						!owned.some(
							(own) =>
								path === own || path.startsWith(`${own.replace(/\/$/, "")}/`),
						),
				),
		),
	];
}
const WRITE_TOOLS = new Set(["write", "edit"]);

function reportText(helper: Helper, report: ChildReport) {
	const head = report.budgetUsed
		? `Agent ${helper.session.id} (${helper.role}) stopped: budget used (${report.budgetUsed}).${report.report ? " Its last message:" : ""}`
		: `Agent ${helper.session.id} (${helper.role}) ${report.outcome === "completed" ? "reported" : "failed"}:`;
	const body = `${head}\n${capText(report.report || "(no report)", LEAD_REPORT_MAX_CHARS, "brief it again for the part you need")}`;
	// A writer's patch block comes after the cap: it must always arrive.
	return report.patch ? `${body}\n\n${report.patch}` : body;
}

export function helperTools(input: {
	parentId: string;
	sessions: TrialSessions;
	model: HarborModel;
	start: StartHelper;
	log?: (line: string) => void;
	/** helpers=write: the writer role too; "worktree" (write-tree) on its own worktree. */
	writers?: boolean | WriterMode;
}): ToolSet {
	const writers: WriterMode | null =
		input.writers === true ? "shared" : input.writers || null;
	const helpers = new Map<string, Helper>();
	const live = () =>
		[...helpers.values()].filter((helper) => helper.running).length;

	const launch = (helper: Helper, brief: string) => {
		helper.pending = null;
		const running = input
			.start(helper.session, helper.role, brief, helper.owns)
			.catch((error: unknown): ChildReport => {
				// The failure must be visible: an empty report alone read as a
				// helper that did nothing.
				input.log?.(
					`helper ${helper.role}: failed (${error instanceof Error ? error.message.slice(0, 200) : String(error)})`,
				);
				return { outcome: "failed", report: "" };
			})
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
				writers === "worktree"
					? "Start a helper in the background. A researcher or reviewer works on its own read-only copy of your checkout; a writer works on its own git worktree of your checkout and reports its work as a patch and git ref for you to review and apply. It sees only your brief (never this conversation) and reports back; keep working and collect the report with agent_wait, or pass wait: true. Returns its id."
					: writers
						? "Start a helper in the background. A researcher or reviewer works on its own read-only copy of your checkout; a writer works in your checkout and may change only the paths in owns. It sees only your brief (never this conversation) and reports back; keep working and collect the report with agent_wait, or pass wait: true. Returns its id."
						: "Start a read-only helper (researcher or reviewer) in the background on its own copy of your checkout. It sees only your brief (never this conversation), cannot change your files, and reports back; keep working and collect the report with agent_wait, or pass wait: true. Returns its id.",
			inputSchema: agentInput(writers),
			execute: async (args) => {
				const { title, brief, wait } = args;
				const role = args.role as HelperRole;
				const owns = (
					"owns" in args ? (args.owns as string[] | undefined) : undefined
				)
					?.map((path) => path.trim())
					.filter(Boolean);
				if (role === "writer" && writers === "shared" && !owns?.length)
					return "Refused: a writer needs owns, the files or directories it may change.";
				if (live() >= MAX_LIVE_HELPERS)
					return `Refused: ${MAX_LIVE_HELPERS} helpers are already running; collect or stop one first, or do the work yourself.`;
				const session = input.sessions.add({
					role: role === "writer" ? "writer" : "helper",
					parentId: input.parentId,
					model: input.model,
					brief,
				});
				const helper: Helper = {
					session,
					role,
					title,
					...(role === "writer" && writers === "shared" ? { owns } : {}),
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
