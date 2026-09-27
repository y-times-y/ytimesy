import { describe, expect, it } from "vitest";
import { progressAdapters } from "./session-progress";

describe("provider-independent progress", () => {
	it("does not emit authentication payloads", () => {
		expect(
			progressAdapters.codex.parse(
				{
					status: JSON.stringify({
						stage: "awaiting_device_code",
						userCode: "secret",
					}),
				},
				"s",
			),
		).toBeNull();
	});
	it("normalizes Claude partial text, stable replay IDs and completion", () => {
		const files = {
			status: JSON.stringify({
				stage: "authenticated",
				turnStatus: "running",
				items: [],
			}),
			output: JSON.stringify({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "hello" },
				},
			}),
		};
		const first = progressAdapters.claude.parse(files, "s");
		expect(first?.items[0]).toMatchObject({
			kind: "agentMessage",
			text: "hello",
			streaming: true,
		});
		expect(first?.turnStatus).toBe("running");
		expect(progressAdapters.claude.parse(files, "s")).toEqual(first);
		expect(
			progressAdapters.claude.parse(
				{
					...files,
					output: `${files.output}\n${JSON.stringify({ type: "result", result: "hello" })}`,
				},
				"s",
			)?.turnStatus,
		).toBe("completed");
	});
});
