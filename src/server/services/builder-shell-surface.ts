import type { ToolSet } from "ai";

/**
 * The shell-shaped builder surface validated on Terminal-Bench (like native
 * Codex): a shell, a patch tool and a few essentials. Specialist tools
 * (run_checks, apply_patches, inspect_changes, plans) cost more turns than
 * they saved in measured builder runs. The prompt profile follows the tools.
 */
export const BUILDER_SHELL_TOOLS = new Set([
	"execute_command",
	"continue_command",
	"stop_command",
	"apply_patch",
	"view_image",
	"read_repository_guidance",
	"read_environment_report",
	"report_task_blocked",
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
