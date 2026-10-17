import type { ModelMessage, ToolSet } from "ai";
import {
	type LeanToolShape,
	leanToolShape,
	type ToolSurfaceVariant,
} from "#/domain/harness-model-profile";
import { writeLeanHistory } from "./lean-helpers";
import { type LeanSurfaceContext, leanShapeTools } from "./lean-tools";

/**
 * The shell-shaped builder surface validated on Terminal-Bench (like native
 * Codex): a shell, a patch tool and a few essentials. Specialist tools
 * (run_checks, apply_patches, inspect_changes, plans) cost more turns than
 * they saved in measured builder runs. The prompt profile follows the tools.
 * Repository instructions arrive as conversation messages, not a tool call.
 */
const BUILDER_SHELL_TOOLS = new Set([
	"execute_command",
	"continue_command",
	"stop_command",
	"apply_patch",
	"view_image",
	"read_environment_report",
	"report_task_blocked",
	// Runs the deliverable from a clean copy before the builder says it is done.
	"check_deliverable",
	// Recover exact detail after compaction; the benchmarked builder has these too.
	"read_context_archive",
	"search_context_history",
	// Product-only: visual QA on the shared desktop. The Terminal-Bench bridge
	// builds its own tool set, so these do not change the measured surface.
	"browser_open",
	"browser_screenshot",
	"browser_inspect",
	"browser_execute",
]);

export function builderShellTools(tools: ToolSet): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => BUILDER_SHELL_TOOLS.has(name)),
	);
}

/** What a lean surface adds to the turn besides its tools. */
export type LeanBuilderSurface = {
	shape: LeanToolShape;
	/** How runtime notices tell the model to read a background command's output. */
	commandReader: string;
	/** The completion gate's hint for commands still running. */
	waitHint: (ids: readonly string[]) => string;
	/** After compaction: writes the archived messages to ~/.ytimesy/history/ and returns the path to cite. */
	saveHistory: (reference: string, messages: ModelMessage[]) => Promise<string>;
};

/**
 * The builder's tool surface, chosen per run (docs/builder-tool-surface.md).
 * "current" is the measured shell surface above. "lean-native" shows each
 * model family its own vendor harness's tools (Codex, Claude Code, Gemini
 * CLI, Qwen Code) and "lean-pi" shows every model Pi's four; both run on the
 * same command runner and limits, keep only report_task_blocked from `tools`
 * (MCP, web search, plugin skills, plan and secret tools are added by the
 * caller as before), and move the helpers to workspace commands.
 */
export function builderToolSurface(
	input:
		| { variant: "current"; modelId: string; tools: ToolSet }
		| {
				variant: Exclude<ToolSurfaceVariant, "current">;
				modelId: string;
				tools: ToolSet;
				lean: LeanSurfaceContext;
		  },
): { tools: ToolSet; lean?: LeanBuilderSurface } {
	if (input.variant === "current")
		return { tools: builderShellTools(input.tools) };
	const shape = leanToolShape(input.variant, input.modelId);
	const { tools, engine } = leanShapeTools(shape, input.tools, input.lean);
	const reader = {
		codex: "write_stdin (its session_id)",
		claude: "Read",
		gemini: "read_file",
		qwen: "read_file",
		pi: "read",
	}[shape];
	return {
		tools: {
			...tools,
			...(input.tools.report_task_blocked
				? { report_task_blocked: input.tools.report_task_blocked }
				: {}),
		},
		lean: {
			shape,
			commandReader:
				shape === "codex"
					? reader
					: `${reader} on ${engine.outputPath("<id>")}`,
			waitHint: (ids) =>
				shape === "codex"
					? "Use write_stdin with each session_id to wait for them (\\u0003 stops one)"
					: `Wait with \`ytimesy-job wait <id>\` or stop with \`ytimesy-job stop <id>\` (ids: ${ids.join(", ")})`,
			saveHistory: async (reference, messages) => {
				try {
					return await writeLeanHistory(
						await input.lean.workspace(),
						reference,
						messages,
					);
				} catch (error) {
					console.warn("Conversation history file was not written.", error);
					return reference;
				}
			},
		},
	};
}
