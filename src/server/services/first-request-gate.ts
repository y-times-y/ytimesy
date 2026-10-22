import type { ToolSet } from "ai";

/**
 * How long a turn's first model request waits for its workspace before it is
 * sent without it. A warm workspace is ready within this, and the request is
 * then built exactly as before; a VM still being bound, created or resumed
 * no longer holds the model's first token back.
 */
export const FIRST_REQUEST_WORKSPACE_WAIT_MS = 400;

/** True once `work` settled (either way) within `ms`; never rejects. */
export async function settlesWithin(work: Promise<unknown>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export type PromptCheck = { block: false } | { block: true; reason: string };

/**
 * A first request sent before its UserPromptSubmit check finished: no tool
 * runs until the check passed. A refused prompt runs nothing (the turn then
 * ends with the refusal); a check that failed fails the call.
 */
export function withPromptCheckGate(
	tools: ToolSet,
	check: Promise<PromptCheck>,
): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, definition]) => {
			const execute = definition.execute;
			if (!execute) return [name, definition];
			return [
				name,
				{
					...definition,
					execute: async (
						args: unknown,
						options: Parameters<NonNullable<typeof execute>>[1],
					) => {
						const checked = await check;
						if (checked.block)
							return {
								blocked: true,
								error: `Blocked by a repository UserPromptSubmit hook: ${checked.reason}`,
							};
						return execute(args as never, options);
					},
				},
			];
		}),
	) as ToolSet;
}
