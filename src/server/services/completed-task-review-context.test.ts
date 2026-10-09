import type { ModelMessage } from "ai";
import { expect, it, vi } from "vitest";
import {
	compactTaskReviewPacket,
	withCompletedTaskReviewContext,
} from "./completed-task-review-context";

const handoff = {
	taskId: "child",
	diff: {
		diff: "complete actual diff",
		sha256: "hash",
		base: "base",
		nextStart: 60000,
	},
	summary: { text: "Implemented; one concern remains", nextStart: 4000 },
	checks: {
		sourceProofs: [
			{
				after: { sources: [{ path: "src/a.ts", sha256: "body-hash" }] },
				sourcesStable: true,
				sourcesCurrent: false,
				checkedRevision: "current",
			},
		],
		checks: [
			{
				reference: "receipt",
				command: "test",
				completion: { status: 0, stopped: null },
				sourceProof: 0,
				stdout: { content: "VERY LARGE LOG" },
				stderr: { content: "PRIVATE LOG" },
			},
		],
	},
	verificationReferences: ["receipt"],
	verificationAssignment: { commands: ["test"] },
	remainingReferences: ["more"],
	failedAttemptReferences: ["failed"],
	failedAttemptsOmitted: 1,
	discoveryIncomplete: true,
};

it("keeps diff cursors, failed/stale evidence and original assignments without repeated logs", () => {
	const packet = compactTaskReviewPacket(handoff);
	expect(packet).toMatchObject({
		diff: handoff.diff,
		summary: handoff.summary,
		remainingReferences: ["more"],
		discoveryIncomplete: true,
		failedAttemptsOmitted: 1,
		checks: [
			{
				reference: "receipt",
				completion: { status: 0 },
				sourcesCurrent: false,
				sourcePaths: ["src/a.ts"],
			},
		],
	});
	expect(JSON.stringify(packet)).not.toMatch(
		/VERY LARGE LOG|PRIVATE LOG|body-hash/,
	);
	expect(JSON.stringify(packet).length).toBeLessThan(
		JSON.stringify(handoff).length,
	);
});

it("collects once per completed revision, preserves opaque history and retries only a new revision", async () => {
	const opaque: ModelMessage = {
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "",
				providerOptions: { openai: { encryptedContent: "unchanged" } },
			},
		],
	};
	const original: ModelMessage[] = [
		{ role: "user", content: "Original contract" },
		opaque,
	];
	const readHandoff = vi.fn(async () => handoff);
	const input = {
		messages: original,
		children: [{ id: "child", revision: "one" }],
		readHandoff,
		signal: new AbortController().signal,
	};
	const first = await withCompletedTaskReviewContext(input);
	expect(first.at(-1)?.role).toBe("user");
	expect(first.slice(0, 2)).toEqual(original);
	expect(first[1]).toBe(opaque);
	const unchanged = await withCompletedTaskReviewContext({
		...input,
		messages: first,
	});
	expect(unchanged).toBe(first);
	expect(readHandoff).toHaveBeenCalledOnce();
	const changed = await withCompletedTaskReviewContext({
		...input,
		messages: first,
		children: [{ id: "child", revision: "two" }],
	});
	expect(changed).toHaveLength(4);
	expect(readHandoff).toHaveBeenCalledTimes(2);
});

it("preserves authoritative baseline receipts alongside compact child evidence", () => {
	const completionVerification = {
		type: "completion-verification",
		directory: "/repo",
		turn: "b".repeat(64),
		base: "c".repeat(40),
		tree: "d".repeat(40),
		patchSha256: "a".repeat(64),
		checks: [
			{
				command: "test all",
				reference: "00000000-0000-4000-8000-000000000001",
				exitCode: 0,
				stopped: null,
			},
		],
	};
	expect(
		compactTaskReviewPacket({ ...handoff, completionVerification }),
	).toMatchObject({ completionVerification });
	expect(compactTaskReviewPacket(handoff).completionVerification).toBeNull();
	expect(() =>
		compactTaskReviewPacket({
			...handoff,
			completionVerification: { ...completionVerification, tree: "invalid" },
		}),
	).toThrow();
});

it("does not turn missing evidence into success or repeatedly wake an unavailable child", async () => {
	const readHandoff = vi.fn(async () => {
		throw new Error("private provider message");
	});
	const input = {
		messages: [],
		children: [{ id: "child", revision: "one" }],
		readHandoff,
		signal: new AbortController().signal,
	};
	const messages = await withCompletedTaskReviewContext(input);
	expect(messages[0].content).toContain('"evidenceUnavailable":true');
	expect(JSON.stringify(messages)).not.toContain("private provider message");
	await withCompletedTaskReviewContext({ ...input, messages });
	expect(readHandoff).toHaveBeenCalledOnce();
	await expect(
		withCompletedTaskReviewContext({ ...input, signal: AbortSignal.abort() }),
	).rejects.toThrow();
});
