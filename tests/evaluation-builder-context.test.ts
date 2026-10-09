import { jsonSchema, tool } from "ai";
import { expect, it, vi } from "vitest";
import { evaluationBuilderContext } from "../benchmarks/evaluation/builder-context";
import { WorkspaceId } from "../src/domain/ids";
import { archiveModelContext } from "../src/server/adapters/context-archives";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

vi.mock("../src/server/adapters/context-archives", async (original) => ({
	...(await original<
		typeof import("../src/server/adapters/context-archives")
	>()),
	archiveModelContext: vi.fn(async () => "context-fixture"),
}));

it("wires production guidance restoration and owner-scoped recoverable archives into the builder evaluator", async () => {
	const guidance = vi.fn(async () => ({
		scope: ".",
		instructions: [{ content: "Preserve existing behavior." }],
	}));
	const input = {
		tools: {
			read_repository_guidance: tool({
				inputSchema: jsonSchema({ type: "object", properties: {} }),
				execute: guidance,
			}),
		},
		workspace: {
			machines: {} as WorkspaceMachines,
			vm: WorkspaceId("fixture"),
			cwd: "/app",
		},
		userId: "owner",
		sessionId: "isolated-builder",
		signal: new AbortController().signal,
		onEvent: vi.fn(async () => {}),
	};
	const context = evaluationBuilderContext(input);
	const history = [{ role: "user" as const, content: "Implement" }];
	const prepared = await context.prepareMessages(history);
	expect(JSON.stringify(prepared)).toContain("Preserve existing behavior");
	expect(context.tools.read_context_archive).toBeDefined();
	expect(context.tools.search_context_history).toBeDefined();
	await context.archiveHistory(prepared);
	expect(archiveModelContext).toHaveBeenCalledWith(
		"owner",
		"isolated-builder",
		prepared,
		undefined,
	);
	await context.afterTools(prepared);
	await context.restoreInstructions(history);
	expect(guidance).toHaveBeenCalledTimes(2);
});
