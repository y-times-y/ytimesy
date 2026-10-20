import { type ToolSet, tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capText, withOutputCap } from "./tool-output-cap";

const lines = (count: number) =>
	Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

const run = (tools: ToolSet, name: string, input: unknown, output: unknown) =>
	tools[name]?.toModelOutput?.({ toolCallId: "c", input, output } as never);

describe("tool output cap", () => {
	it("keeps the head and tail of a long text and says what was cut", () => {
		const text = lines(5000);
		const capped = capText(text, 2000, "see /tmp/out");
		expect(capped.length).toBeLessThan(2300);
		expect(capped.startsWith("line 1\n")).toBe(true);
		expect(capped.endsWith("line 5000")).toBe(true);
		expect(capped).toMatch(
			/\[\.\.\. \d+ characters \(\d+ lines\) cut from the middle of this \d+-character result; see \/tmp\/out \.\.\.\]/,
		);
		expect(capText("short", 2000, "x")).toBe("short");
	});

	it("caps a command's model output with its output file, and leaves short results alone", async () => {
		const bash = tool({
			description: "bash",
			inputSchema: z.object({ command: z.string() }),
			execute: async () => ({ output: "", outputPath: "/tmp/agent/1.stdout" }),
			toModelOutput: ({ output }) => ({
				type: "text" as const,
				value: (output as { output: string }).output,
			}),
		});
		const read = tool({
			description: "read",
			inputSchema: z.object({ path: z.string() }),
			execute: async () => "",
		});
		const tools = withOutputCap({ bash, read }, 1000);
		const long = await run(
			tools,
			"bash",
			{ command: "seq 1 5000" },
			{ output: lines(5000), outputPath: "/tmp/agent/1.stdout" },
		);
		expect(long).toMatchObject({ type: "text" });
		const value = (long as { value: string }).value;
		expect(value.length).toBeLessThan(1300);
		expect(value).toContain(
			"the full output is in /tmp/agent/1.stdout; read the part you need with sed -n '<from>,<to>p' or grep -n",
		);
		expect(await run(tools, "read", { path: "a" }, "tiny")).toEqual({
			type: "text",
			value: "tiny",
		});
		const file = await run(tools, "read", { path: "a" }, lines(5000));
		expect((file as { value: string }).value).toContain(
			"read the cut lines with a narrower offset and limit",
		);
		// Off: the tools are returned unchanged.
		expect(withOutputCap({ bash }, undefined).bash).toBe(bash);
	});
});
