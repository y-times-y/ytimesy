import { expect, it } from "vitest";
import { evaluationBuilderTools } from "../benchmarks/evaluation/builder-tools";
import { WorkspaceId } from "../src/domain/ids";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

it("exposes real builder tools without orchestration or publication", () => {
	const tools = evaluationBuilderTools({
		machines: {} as WorkspaceMachines,
		vm: WorkspaceId("isolated"),
		cwd: "/app",
		sessionId: "builder",
		turnId: "turn",
		signal: new AbortController().signal,
	});
	expect(tools).toHaveProperty("apply_patches");
	expect(tools).toHaveProperty("read_file");
	expect(tools).toHaveProperty("list_files");
	expect(tools).toHaveProperty("search_files");
	expect(tools).toHaveProperty("run_checks");
	expect(tools).toHaveProperty("read_repository_guidance");
	expect(
		Object.keys(tools).some((name) => /task|delegate|publish/.test(name)),
	).toBe(false);
});
