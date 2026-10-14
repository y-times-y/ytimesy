import { tool } from "ai";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
	PLAN_MODE_NOTICE,
	withPlanMode,
	withPlanModeNotice,
} from "./plan-mode";

const options = {
	toolCallId: "c",
	messages: [],
	abortSignal: new AbortController().signal,
	context: {},
};

it("refuses tools that would start writing work and leaves the rest working", async () => {
	const ran = vi.fn(async () => ({ ok: true }));
	const make = () =>
		tool({ inputSchema: z.object({}).passthrough(), execute: ran });
	const tools = withPlanMode({
		create_task: make(),
		launch_ready_tasks: make(),
		start_task: make(),
		batch_read: make(),
	});
	const refused = {
		blocked: true,
		error: expect.stringContaining("Plan mode"),
	};
	expect(
		await tools.create_task.execute?.(
			{ startImmediately: true, access: "read_write" },
			options,
		),
	).toEqual(refused);
	expect(await tools.launch_ready_tasks.execute?.({}, options)).toEqual(
		refused,
	);
	expect(await tools.start_task.execute?.({}, options)).toEqual(refused);
	expect(ran).not.toHaveBeenCalled();
	// Drafts, read-only helpers and ordinary reads still run.
	await tools.create_task.execute?.({ startImmediately: false }, options);
	await tools.create_task.execute?.(
		{ startImmediately: true, access: "read_only" },
		options,
	);
	await tools.batch_read.execute?.({}, options);
	expect(ran).toHaveBeenCalledTimes(3);
});

it("adds the plan notice once after the conversation", () => {
	const once = withPlanModeNotice([{ role: "user", content: "Fix login" }]);
	expect(once.at(-1)).toEqual({ role: "user", content: PLAN_MODE_NOTICE });
	expect(withPlanModeNotice(once)).toHaveLength(2);
});

it("refuses the builder's own file edits and publishing, but still runs commands", async () => {
	const ran = vi.fn(async () => ({ ok: true }));
	const make = () =>
		tool({ inputSchema: z.object({}).passthrough(), execute: ran });
	const tools = withPlanMode({
		apply_patch: make(),
		apply_patches: make(),
		replace_text: make(),
		rename_symbol: make(),
		publish_task: make(),
		execute_command: make(),
		view_image: make(),
	});
	for (const name of [
		"apply_patch",
		"apply_patches",
		"replace_text",
		"rename_symbol",
		"publish_task",
	])
		expect(await tools[name].execute?.({}, options)).toMatchObject({
			blocked: true,
		});
	expect(ran).not.toHaveBeenCalled();
	await tools.execute_command.execute?.({}, options);
	await tools.view_image.execute?.({}, options);
	expect(ran).toHaveBeenCalledTimes(2);
	expect(PLAN_MODE_NOTICE).toContain("Do not edit files");
});
