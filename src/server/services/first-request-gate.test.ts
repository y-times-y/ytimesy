import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { settlesWithin, withPromptCheckGate } from "./first-request-gate";

describe("settlesWithin", () => {
	it("tells a settled promise (either way) from one still pending", async () => {
		expect(await settlesWithin(Promise.resolve(1), 50)).toBe(true);
		expect(await settlesWithin(Promise.reject(new Error("no")), 50)).toBe(true);
		expect(await settlesWithin(new Promise(() => {}), 20)).toBe(false);
	});
});

describe("withPromptCheckGate", () => {
	const options = { toolCallId: "call", messages: [], context: {} };
	const probe = () => {
		const run = vi.fn(async () => "ran");
		return {
			run,
			tools: {
				bash: tool({
					inputSchema: z.object({}),
					execute: run,
				}),
			},
		};
	};

	it("runs no tool until the check passed", async () => {
		let pass = () => {};
		const check = new Promise<{ block: false }>((resolve) => {
			pass = () => resolve({ block: false });
		});
		const { run, tools } = probe();
		const result = withPromptCheckGate(tools, check).bash.execute?.(
			{},
			options,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(run).not.toHaveBeenCalled();
		pass();
		expect(await result).toBe("ran");
		expect(run).toHaveBeenCalledOnce();
	});

	it("runs nothing for a refused prompt, and fails the call when the check failed", async () => {
		const refused = probe();
		expect(
			await withPromptCheckGate(
				refused.tools,
				Promise.resolve({ block: true, reason: "Name the ticket." }),
			).bash.execute?.({}, options),
		).toEqual({
			blocked: true,
			error: "Blocked by a repository UserPromptSubmit hook: Name the ticket.",
		});
		expect(refused.run).not.toHaveBeenCalled();
		const failed = probe();
		const broken = Promise.reject(new Error("workspace failed"));
		broken.catch(() => {});
		await expect(
			withPromptCheckGate(failed.tools, broken).bash.execute?.({}, options),
		).rejects.toThrow("workspace failed");
		expect(failed.run).not.toHaveBeenCalled();
	});
});
