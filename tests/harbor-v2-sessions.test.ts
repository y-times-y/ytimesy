import { describe, expect, it } from "vitest";
import type { HarborModel } from "../evals/harbor_v2/config";
import { trialSessions } from "../evals/harbor_v2/sessions";

const model = {
	modelId: "m",
	effort: "low",
	billing: { kind: "api" },
} as unknown as HarborModel;

describe("trialSessions", () => {
	it("keeps the trial's child sessions in memory, by parent and role", () => {
		const store = trialSessions(() => 0);
		const sidekick = store.add({ role: "sidekick", parentId: "t", model });
		const checker = store.add({
			role: "checker",
			parentId: "t",
			model,
			id: "harbor-checker-1",
		});
		const worker = store.add({
			role: "checkerWorker",
			parentId: checker.id,
			model,
		});
		const classifier = store.add({
			role: "classifier",
			parentId: sidekick.id,
			model,
		});
		expect(sidekick.id).toBe("t.1");
		expect(worker.id).toBe("harbor-checker-1.1");
		expect(classifier.id).toBe("t.1.1");
		expect(store.children("t").map((s) => s.id)).toEqual([
			"t.1",
			"harbor-checker-1",
		]);
		expect(store.children(checker.id)).toEqual([worker]);
		expect(store.byRole("classifier")).toEqual([classifier]);
		expect(store.latestReport(sidekick.id)).toBeNull();
		sidekick.reports.push({ outcome: "completed", report: "done" });
		expect(store.latestReport(sidekick.id)?.report).toBe("done");
		expect(() =>
			store.add({
				role: "checker",
				parentId: "t",
				model,
				id: "harbor-checker-1",
			}),
		).toThrow(/already exists/);
	});
});
