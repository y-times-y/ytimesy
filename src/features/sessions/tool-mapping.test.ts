import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ENTER_PLAN_MODE_TOOL, PROPOSE_PLAN_TOOL } from "#/domain/agent-plan";
import { ATTEMPT_CHECK_TOOL, REVIEW_CHECK_TOOL } from "#/domain/check-summary";
import { CODE_MODE_TOOL } from "#/domain/code-mode";
import { leanToolNames } from "#/domain/harness-model-profile";
import { harnessToolName } from "#/domain/harness-performance";
import { SessionItemId } from "#/domain/ids";
import { IMAGE_VIEWING_TOOLS } from "#/domain/image-placeholders";
import {
	CALL_MCP_TOOL_TOOL,
	mcpToolName,
	SEARCH_MCP_TOOLS_TOOL,
} from "#/domain/mcp-tool-call";
import type { ModelProvider } from "#/domain/model-connection";
import { REQUEST_PROJECT_SECRET_TOOL } from "#/domain/secret-request";
import {
	activityGlyphForToolName,
	hasToolGlyph,
} from "#/domain/session-activity";
import type { DynamicToolCallItem, SessionItem } from "#/domain/session-item";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "#/domain/subagent";
import { toolActivity } from "#/domain/tool-detail";
import { nativeWebSearchTools } from "#/server/adapters/native-web-search";
import { BUILDER_SHELL_TOOLS } from "#/server/services/builder-shell-surface";
import { CODE_MODE_DEFERRED_TOOLS } from "#/server/services/deferred-tools";
import { pluginSkillTools } from "#/server/services/plugin-skill-tools";
import { secretRequestTools } from "#/server/services/secret-request-tool";
import { SessionTimeline } from "./session-timeline";

// Replies render through the real Markdown renderer (the app loads it lazily).
vi.mock("./agent-markdown", async () => ({
	AgentMarkdown: (await import("./agent-markdown-renderer")).AgentMarkdown,
}));

/**
 * Every tool name the harness can write into a chat, from the lists and
 * factories that build its tool sets, so a tool added there without a chat
 * label and icon fails here.
 */
function harnessToolNames(): string[] {
	const providers: ModelProvider[] = [
		"openai",
		"anthropic",
		"google",
		"openrouter",
	];
	return [
		...new Set([
			...leanToolNames(),
			...BUILDER_SHELL_TOOLS,
			...providers.flatMap((provider) =>
				Object.keys(nativeWebSearchTools(provider)),
			),
			...Object.keys(
				pluginSkillTools([
					{
						plugin: "acme",
						skills: [{ name: "release", description: "Release" }],
					},
				] as never),
			),
			...Object.keys(secretRequestTools([])),
			ENTER_PLAN_MODE_TOOL,
			PROPOSE_PLAN_TOOL,
			REQUEST_PROJECT_SECRET_TOOL,
			SEARCH_MCP_TOOLS_TOOL,
			CALL_MCP_TOOL_TOOL,
			...CODE_MODE_DEFERRED_TOOLS,
			...IMAGE_VIEWING_TOOLS,
			AGENT_TOOL,
			AGENT_SEND_TOOL,
			CODE_MODE_TOOL,
			REVIEW_CHECK_TOOL,
			ATTEMPT_CHECK_TOOL,
			// Recorded tool names, the retired lead/child task tools included.
			...harnessToolName.options.filter((name) => name !== "other"),
		]),
	];
}

const call = (tool: string): DynamicToolCallItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(`call:${tool}`),
	tool,
	input: "{}",
	status: "completed",
});

describe("chat tool mapping", () => {
	const names = harnessToolNames();

	it("collects the harness's tools from its own lists", () => {
		for (const name of [
			"bash",
			"exec_command",
			"Glob",
			"grep_search",
			"execute_command",
			"browser_inspect",
			"web_search",
			"google_search",
			"read_plugin_skill",
			"enter_plan_mode",
			"request_project_secret",
			"agent",
			"agent_send",
			"run_code",
			"review_check",
			"check_deliverable",
		])
			expect(names).toContain(name);
	});

	it.each(names.map((name) => [name]))(
		"%s has its own icon and label",
		(name) => {
			expect(hasToolGlyph(name)).toBe(true);
			expect(activityGlyphForToolName(name)).not.toBe("tool");
			expect(toolActivity(call(name)).fallback).toBeUndefined();
		},
	);

	it("gives MCP tools the MCP icon whatever they are named", () => {
		const name = mcpToolName("github", "search_issues");
		expect(activityGlyphForToolName(name)).toBe("mcp");
		expect(toolActivity(call(name))).toMatchObject({
			verb: "github",
			target: "search issues",
		});
	});

	it("still names an unknown tool in words as the fallback", () => {
		expect(toolActivity(call("brand_new_tool"))).toMatchObject({
			verb: "Brand new tool",
			fallback: true,
		});
		expect(hasToolGlyph("brand_new_tool")).toBe(false);
	});
});

function render(items: SessionItem[], turnStatus: "running" | "completed") {
	return renderToString(createElement(SessionTimeline, { items, turnStatus }));
}

const prompt: SessionItem = {
	kind: "userMessage",
	id: SessionItemId("prompt"),
	text: "Add a CSV export",
};

describe("timeline cards for harness items", () => {
	it("renders a review record as a verdict card, not a raw result", () => {
		const html = render(
			[
				prompt,
				{
					kind: "dynamicToolCall",
					id: SessionItemId("review"),
					tool: REVIEW_CHECK_TOOL,
					input: "independent review 1 of up to 2",
					output:
						"Review 1: fail (2 findings) · fixed 1, rejected 1\nF1. Quotes break rows.\nF2. Missing total.\nFailing test: quotes (`node t.mjs`)\nChecker tests: 4 run, 1 failed.\nChecker spent 182k tokens · $0.44.",
					status: "completed",
				},
			],
			"running",
		);
		expect(html).toContain('data-kind="check"');
		expect(html).toContain('data-verdict="fail"');
		expect(html).toContain("Review 1 of 2");
		expect(html).toContain(
			"2 findings · 4 tests, 1 failed · fixed 1, rejected 1",
		);
		expect(html).toContain("F1. Quotes break rows.");
		expect(html).not.toContain("Result");
	});

	it("renders an agent call with its role, title, model and report", () => {
		const html = render(
			[
				prompt,
				{
					kind: "dynamicToolCall",
					id: SessionItemId("agent"),
					tool: AGENT_TOOL,
					input: JSON.stringify({
						role: "reviewer",
						title: "Review the diff",
						brief: "Look for edge cases.",
						wait: true,
					}),
					output: JSON.stringify({
						id: "2",
						taskId: "t2",
						role: "reviewer",
						model: "Claude Fable 5",
						outcome: "finished",
						report:
							"[agent 2 reviewer finished · 14 steps · 3m · 120k tokens]\n\nQuotes are not escaped.",
					}),
					status: "completed",
				},
			],
			"running",
		);
		expect(html).toContain('data-kind="agentCall"');
		// Named by its task with a kind tag (helper-names.ts), not its role.
		expect(html).toContain('<span class="agent-row-tag">Review</span>');
		expect(html).not.toContain("Reviewer");
		expect(html).toContain("Review the diff");
		expect(html).toContain("Claude Fable 5");
		expect(html).toContain("Finished");
		expect(html).toContain("Quotes are not escaped.");
		expect(html).not.toContain("[agent 2");
		expect(html).not.toContain("&quot;taskId&quot;");
	});

	it("lists run_code's inner calls by what they did, the program collapsed", () => {
		const html = render(
			[
				prompt,
				{
					kind: "dynamicToolCall",
					id: SessionItemId("code"),
					tool: CODE_MODE_TOOL,
					input: JSON.stringify({ code: "await tools.read({ path: 'a.ts' })" }),
					output: JSON.stringify({
						ok: true,
						result: "done",
						calls: [
							{
								tool: "read",
								input: JSON.stringify({ path: "a.ts" }),
								status: "completed",
								ms: 3,
								output: "x",
							},
							{
								tool: "bash",
								input: JSON.stringify({ command: "pnpm test" }),
								status: "completed",
								ms: 3,
								output: "ok",
							},
						],
					}),
					status: "completed",
				},
			],
			"running",
		);
		expect(html).toContain("Read · Ran");
		expect(html).toContain("2 tool calls");
		expect(html).toContain("Program · 1 line");
		expect(html).toContain("<dt>path</dt>");
		expect(html).not.toContain("{&quot;path&quot;");
	});

	it("renders the builder's requirements block as a collapsed list", () => {
		const html = render(
			[
				prompt,
				{
					kind: "agentMessage",
					id: SessionItemId("req"),
					text: "<requirements>\n- CSV columns id, name\n- Quote fields\n</requirements>\n\nStarting.",
				},
			],
			"running",
		);
		expect(html).toContain('<details class="session-requirements">');
		expect(html).toContain("<li>CSV columns id, name</li>");
		expect(html).toContain("Starting.");
		expect(html).not.toContain("&lt;requirements&gt;");
	});

	it("shows model switches and server notes as quiet system notices", () => {
		const html = render(
			[
				prompt,
				{
					kind: "modelSwitch",
					id: SessionItemId("switch"),
					message: "Switched from A to B at a context compaction (stuck).",
					reason: "sidekick-escalation",
					from: { model: "a", connection: "c" },
					to: { model: "b", connection: "c", key: "c|b" },
					state: "switched",
				},
				{
					kind: "notice",
					id: SessionItemId("notice"),
					message: "Changes are committed in this chat but were not pushed.",
				},
			],
			"completed",
		);
		expect(html.match(/session-system-notice/g)).toHaveLength(2);
		expect(html).toContain('data-reason="sidekick-escalation"');
	});

	it("says the running turn is compacting its context", () => {
		const html = render(
			[
				{
					...prompt,
					contextUsage: { compacting: true } as never,
				} as SessionItem,
			],
			"running",
		);
		expect(html).toContain("Compacting context");
	});
});
