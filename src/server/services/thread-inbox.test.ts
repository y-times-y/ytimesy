import { describe, expect, it, vi } from "vitest";
import { answerThread, readThreadAsk } from "./thread-inbox";

const chat = (over: Record<string, unknown> = {}) =>
	({
		id: "t1",
		projectId: "p",
		harness: "api",
		listedModelId: "m",
		parentSessionId: null,
		agentRole: null,
		...over,
	}) as never;

describe("thread inbox", () => {
	it("reads the open question of the person's own thread only", async () => {
		const question = {
			kind: "userQuestion",
			id: "q",
			questions: [
				{ question: "a?", options: [{ label: "x" }, { label: "y" }] },
			],
		};
		const deps = {
			metadata: vi.fn(async (_u: string, id: string) =>
				id === "t1" ? chat() : id === "other" ? chat({ projectId: "z" }) : null,
			),
			page: vi.fn(async () => ({ items: [question] }) as never),
		};
		const base = { userId: "u", projectId: "p" };
		expect(
			await readThreadAsk({ ...base, threadId: "t1" }, deps),
		).toMatchObject({
			kind: "question",
		});
		expect(
			await readThreadAsk({ ...base, threadId: "other" }, deps),
		).toBeNull();
		expect(await readThreadAsk({ ...base, threadId: "none" }, deps)).toBeNull();
		expect(deps.page).toHaveBeenCalledTimes(1);
	});

	it("sends the answer as the person through the send path, on the thread's own model", async () => {
		const send = vi.fn(async () => ({ turnStatus: "running" }));
		const metadata = vi.fn(async () => chat());
		const done = await answerThread(
			{} as never,
			{ userId: "u", projectId: "p", threadId: "t1", text: " stderr " },
			{ metadata, send },
		);
		expect(done).toEqual({ ok: true, turnStatus: "running" });
		expect(send).toHaveBeenCalledWith(
			{},
			{
				userId: "u",
				projectId: "p",
				sessionId: "t1",
				harnessId: "api",
				createNew: false,
			},
			{ text: "stderr", modelId: "m" },
		);
	});

	it("refuses empty text, another project's thread and a thread with no model", async () => {
		const send = vi.fn();
		const base = { userId: "u", projectId: "p", threadId: "t1" };
		expect(
			await answerThread(
				{} as never,
				{ ...base, text: "  " },
				{ metadata: async () => chat(), send },
			),
		).toMatchObject({ ok: false });
		expect(
			await answerThread(
				{} as never,
				{ ...base, text: "x" },
				{ metadata: async () => chat({ projectId: "z" }), send },
			),
		).toMatchObject({ ok: false, error: "No such thread in this project." });
		expect(
			await answerThread(
				{} as never,
				{ ...base, text: "x" },
				{ metadata: async () => chat({ listedModelId: null }), send },
			),
		).toMatchObject({ ok: false, error: "Open the thread to answer it." });
		expect(send).not.toHaveBeenCalled();
	});
});
