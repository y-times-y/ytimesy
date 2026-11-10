import { expect, it } from "vitest";
import { durableObjectState } from "../../../tests/support/durable-object-state";
import {
	ClaudeRunnerPlacement,
	pinnedClaudeRunner,
	withClaudeRunnerPlacement,
} from "./claude-runner-placement";

it("keeps a chat on its persisted box across resets and pool changes without storing the secret", async () => {
	const sql = durableObjectState().ctx.storage.sql;
	const placement = new ClaudeRunnerPlacement(sql as never);
	const original = {
		baseUrl: "https://runner-a.example",
		secret: "a".repeat(40),
	};
	expect(
		await withClaudeRunnerPlacement(
			(url) => placement.assign(url),
			async () => pinnedClaudeRunner(original),
		),
	).toEqual(original);
	const restarted = new ClaudeRunnerPlacement(sql as never);
	const changed = {
		baseUrl: "https://runner-b.example",
		secret: "b".repeat(40),
	};
	expect(
		await withClaudeRunnerPlacement(
			(url) => restarted.assign(url),
			async () => pinnedClaudeRunner(changed),
		),
	).toEqual({ baseUrl: original.baseUrl, secret: changed.secret });
	expect(sql.exec("select * from claude_runner_placement").toArray()).toEqual([
		{ id: 1, base_url: original.baseUrl },
	]);
});

it("does not borrow another conversation's assignment and refuses a missing placement scope", async () => {
	const first = new ClaudeRunnerPlacement(
		durableObjectState().ctx.storage.sql as never,
	);
	const second = new ClaudeRunnerPlacement(
		durableObjectState().ctx.storage.sql as never,
	);
	expect(first.assign("https://first.example")).toBe("https://first.example");
	expect(second.assign("https://second.example")).toBe(
		"https://second.example",
	);
	expect(() =>
		pinnedClaudeRunner({
			baseUrl: "https://third.example",
			secret: "x".repeat(40),
		}),
	).toThrow("placement is unavailable");
	expect(() => first.assign("http://unsafe.example")).toThrow(
		"Invalid runner origin",
	);
});
