import { describe, expect, it } from "vitest";
import { setupProgress } from "./setup-steps";

const none = { githubConnected: false, modelReady: false };

describe("setupProgress", () => {
	it("starts at GitHub, with two required steps", () => {
		const p = setupProgress({
			state: none,
			repositoryCount: null,
			sessionsSkipped: false,
		});
		expect(p.current).toBe("github");
		expect(p.settled).toBe(0);
		expect(p.total).toBe(2);
		expect(p.steps.map((s) => s.status)).toEqual(["current", "todo", "todo"]);
	});
	it("needs the app on a repository, not just a GitHub sign-in", () => {
		const signedInOnly = setupProgress({
			state: { githubConnected: true, modelReady: false },
			repositoryCount: 0,
			sessionsSkipped: false,
		});
		expect(signedInOnly.current).toBe("github");
		const installed = setupProgress({
			state: { githubConnected: true, modelReady: false },
			repositoryCount: 2,
			sessionsSkipped: false,
		});
		expect(installed.current).toBe("model");
		expect(installed.settled).toBe(1);
	});
	it("a model can be ready before GitHub; the order still follows the list", () => {
		const p = setupProgress({
			state: { githubConnected: false, modelReady: true },
			repositoryCount: null,
			sessionsSkipped: false,
		});
		expect(p.steps.map((s) => s.status)).toEqual(["current", "done", "todo"]);
		expect(p.settled).toBe(1);
	});
	it("is complete once GitHub and a model are done, without importing or skipping", () => {
		const p = setupProgress({
			state: { githubConnected: true, modelReady: true },
			repositoryCount: 1,
			sessionsSkipped: false,
		});
		expect(p.complete).toBe(true);
		expect(p.settled).toBe(2);
		expect(p.total).toBe(2);
	});
	it("shows a skipped import as skipped and never counts it", () => {
		const p = setupProgress({
			state: { githubConnected: true, modelReady: false },
			repositoryCount: 1,
			sessionsSkipped: true,
		});
		expect(p.steps[2]).toMatchObject({ status: "skipped", optional: true });
		expect(p.settled).toBe(1);
		expect(p.complete).toBe(false);
	});
	it("skipping the import never completes setup on its own", () => {
		const p = setupProgress({
			state: none,
			repositoryCount: null,
			sessionsSkipped: true,
		});
		expect(p.complete).toBe(false);
	});
});
