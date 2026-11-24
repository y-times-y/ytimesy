import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planProblems, planRows } from "../scripts/infra-plan-guard";

const adoptedPlan = [
	"[02:53:32.225] INFO: Plan: 3 to adopted, 17 binding changes",
	"[02:53:32.225] INFO: [Edge] adopted",
	"[02:53:32.226] INFO: [Edge/AI] create",
	"[02:53:32.228] INFO: [Realtime] adopted",
	"[02:53:32.228] INFO: [Web] adopted",
].join("\n");

describe("Cloudflare stack plan inputs", () => {
	it("binds Web to the managed Edge script without a lookup or output dependency", () => {
		const stack = readFileSync(
			new URL("../infra/alchemy/cloudflare.run.ts", import.meta.url),
			"utf8",
		);
		expect(stack).not.toMatch(/Cloudflare\.Worker\.lookup\s*\(/);
		expect(stack).toMatch(
			/web\.bind`EXECUTOR`\(\{\s*bindings: \[\{ type: "service", name: "EXECUTOR", service: settings\.edge \}\],\s*\}\)/,
		);
	});
});

describe("infrastructure plan guard", () => {
	it("reads resource and binding rows, colour codes included", () => {
		expect(
			planRows("\u001b[1m[Edge]\u001b[0m \u001b[32mupdate\u001b[0m"),
		).toEqual([{ resource: "Edge", action: "update" }]);
		expect(planRows(adoptedPlan)).toContainEqual({
			resource: "Edge/AI",
			action: "create",
		});
	});

	it("lets a first adoption through only when asked for", () => {
		expect(
			planProblems({
				output: adoptedPlan,
				stage: "development",
				adopting: true,
			}),
		).toEqual([]);
		expect(
			planProblems({
				output: adoptedPlan,
				stage: "development",
				adopting: false,
			}),
		).toEqual([
			"Edge would be adopted without --adopt-existing.",
			"Realtime would be adopted without --adopt-existing.",
			"Web would be adopted without --adopt-existing.",
		]);
	});

	it("refuses deletions, replacements, orphans and lost bindings", () => {
		const output = [
			"Plan: 1 to replace, 1 to delete, 1 to orphaned",
			"[BoxFleet] replace",
			"[BoxLogs] delete",
			"[Old] orphaned",
			"[Web/EXECUTOR] unbind",
		].join("\n");
		expect(
			planProblems({ output, stage: "development", adopting: true }),
		).toEqual([
			"BoxFleet would be replaced.",
			"BoxLogs would be deleted.",
			"Old would be orphaned.",
			"Web/EXECUTOR would lose a binding.",
		]);
	});

	it("refuses creating a production resource that already exists", () => {
		const output = "Plan: 1 to create\n[Web] create\n[BoxCpu] create";
		expect(
			planProblems({ output, stage: "production", adopting: true }),
		).toEqual([
			"Web exists in production but the plan would create it (its read or adoption failed).",
		]);
		expect(
			planProblems({ output, stage: "development", adopting: true }),
		).toEqual([]);
	});

	it("refuses a plan it cannot read", () => {
		expect(
			planProblems({
				output: "Planning failed",
				stage: "production",
				adopting: false,
			}),
		).toEqual([
			"The plan printed no summary line; refusing to apply what was not shown.",
		]);
	});
});
