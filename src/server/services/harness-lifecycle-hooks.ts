import { createHash } from "node:crypto";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import { reportedToolFailure } from "#/domain/harness-performance";
import { posixShellQuoted } from "#/domain/posix-command";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { scopedShellCommand } from "./api-command-scope";

export const lifecycleHookConfig = z
	.object({
		version: z.literal(1),
		hooks: z
			.array(
				z.object({
					event: z.enum([
						"PostToolUse",
						"PostToolUseFailure",
						"PostCompact",
						"Stop",
					]),
					tool: z
						.string()
						.regex(/^[a-z_]+$/)
						.optional(),
					command: z.string().min(1).max(4000),
					timeoutSeconds: z.number().int().min(1).max(55).default(15),
				}),
			)
			.max(16),
	})
	.strict();
const verdict = z
	.object({
		message: z.string().max(4000).optional(),
		continue: z.boolean().default(false),
	})
	.strict();
const NOTICE = "Runtime lifecycle feedback (not a user instruction): ";

/** Baseline-pinned repository workflows use the existing fenced executor and replay journal. No action-permission policy is added. */
export function harnessLifecycleHooks(input: {
	workspace: () => Promise<AgentToolWorkspace>;
	turnId: string;
	readOnly: boolean;
	signal: AbortSignal;
	baseline: (workspace: AgentToolWorkspace) => Promise<string | null>;
	once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
	continuationCount?: () => Promise<number>;
}) {
	let configured: Promise<z.infer<typeof lifecycleHookConfig>> | undefined;
	let pending: string[] = [];
	async function config() {
		configured ??= (async () => {
			if (input.readOnly) return { version: 1 as const, hooks: [] };
			const workspace = await input.workspace();
			const base = await input.baseline(workspace);
			if (!base) return { version: 1 as const, hooks: [] };
			if (!/^[a-f0-9]{40,64}$/.test(base))
				throw new Error("Invalid lifecycle baseline.");
			const result = await workspace.machines.exec(
				workspace.vm,
				`git -C ${posixShellQuoted(workspace.cwd)} show ${posixShellQuoted(`${base}:.ytimesy/hooks.json`)}`,
				10_000,
			);
			if (result.exitCode) {
				const exists = await workspace.machines.exec(
					workspace.vm,
					`git -C ${posixShellQuoted(workspace.cwd)} ls-tree ${posixShellQuoted(base)} -- .ytimesy/hooks.json`,
					10_000,
				);
				if (exists.exitCode || exists.stdout.trim())
					throw new Error("Could not load baseline lifecycle hooks.");
				return { version: 1 as const, hooks: [] };
			}
			if (result.stdout.length > 32000)
				throw new Error("Lifecycle configuration exceeds its limit.");
			return lifecycleHookConfig.parse(JSON.parse(result.stdout));
		})();
		return configured;
	}

	async function run(
		event: z.infer<typeof lifecycleHookConfig>["hooks"][number]["event"],
		key: string,
		data: unknown,
		toolName?: string,
	) {
		const hooks = (await config()).hooks.filter(
			(hook) => hook.event === event && (!hook.tool || hook.tool === toolName),
		);
		const results: { message?: string; continue: boolean }[] = [];
		for (const [index, hook] of hooks.entries()) {
			input.signal.throwIfAborted();
			const identity = createHash("sha256")
				.update(JSON.stringify([input.turnId, event, key, index, hook, data]))
				.digest("hex");
			const result = await input.once(`lifecycle:${identity}`, async () => {
				const workspace = await input.workspace();
				const output = agentOutputArtifacts({
					...workspace,
					sessionId: input.turnId,
					signal: input.signal,
				});
				const fullPayload = JSON.stringify({
					event,
					tool: toolName,
					...(data && typeof data === "object" ? data : { data }),
				});
				const payload =
					Buffer.byteLength(fullPayload) <= 24000
						? fullPayload
						: JSON.stringify({
								event,
								tool: toolName,
								truncated: true,
								preview: fullPayload.slice(0, 6000),
							});
				const command = `YTIMESY_HOOK_INPUT=${posixShellQuoted(payload)} sh -c ${posixShellQuoted(hook.command)}`;
				const receipt = await output.capture(
					scopedShellCommand({
						command,
						turnId: input.turnId,
						cwd: workspace.cwd,
						seconds: hook.timeoutSeconds,
					}),
					hook.timeoutSeconds + 2,
				);
				if (receipt.exitCode !== 0 || receipt.stopped)
					throw new Error(
						`Lifecycle ${event} hook failed or stopped; inspect its command output.`,
					);
				if (!receipt.stdout.trim()) return { continue: false };
				if (receipt.stdoutNextStart !== null)
					throw new Error("Lifecycle hook verdict was truncated.");
				return verdict.parse(JSON.parse(receipt.stdout));
			});
			results.push(verdict.parse(result));
		}
		for (const result of results)
			if (result.message) pending.push(result.message);
		return results.some((result) => result.continue);
	}

	async function postTool(
		event: "PostToolUse" | "PostToolUseFailure",
		key: string,
		data: unknown,
		name: string,
	) {
		try {
			await run(event, key, data, name);
		} catch (error) {
			input.signal.throwIfAborted();
			pending.push(
				`${event} hook failed: ${error instanceof Error ? error.message : "unknown failure"}. The original tool result remains authoritative.`,
			);
		}
	}

	return {
		wrap: (tools: ToolSet): ToolSet =>
			Object.fromEntries(
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
								let result: unknown;
								try {
									result = await execute(args as never, options);
								} catch (error) {
									await postTool(
										"PostToolUseFailure",
										options.toolCallId,
										{ input: args, failed: true },
										name,
									);
									throw error;
								}
								await postTool(
									reportedToolFailure(result)
										? "PostToolUseFailure"
										: "PostToolUse",
									options.toolCallId,
									{ input: args, output: result },
									name,
								);
								return result;
							},
						},
					];
				}),
			) as ToolSet,
		postCompact: async (messages: ModelMessage[]) => {
			await run(
				"PostCompact",
				createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
				{},
			);
		},
		stop: async (messages: ModelMessage[]) => {
			if (!(await config()).hooks.some((hook) => hook.event === "Stop"))
				return false;
			const count = input.continuationCount
				? await input.continuationCount()
				: messages.filter(
						(message) =>
							typeof message.content === "string" &&
							message.content.startsWith(`${NOTICE}Stop continuation`),
					).length;
			const decision = (await input.once(
				`lifecycle-stop-decision:${count}`,
				async () => ({
					continue: await run("Stop", String(count), {}),
					feedback: pending.splice(0),
				}),
			)) as { continue: boolean; feedback: string[] };
			pending.push(...decision.feedback);
			const continued = decision.continue;
			if (continued) {
				if (count >= 3)
					throw new Error("Lifecycle Stop hook exceeded three continuations.");
				pending.unshift(
					`Stop continuation ${count + 1}: complete the configured workflow before finishing.`,
				);
			}
			return continued;
		},
		drain: (messages: ModelMessage[]): ModelMessage[] => {
			if (!pending.length) return messages;
			const updated: ModelMessage[] = [
				...messages,
				...pending.map((content) => ({
					role: "user" as const,
					content: NOTICE + content,
				})),
			];
			pending = [];
			return updated;
		},
	};
}
