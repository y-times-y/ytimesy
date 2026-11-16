import { createHash } from "node:crypto";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import { reportedToolFailure } from "#/domain/harness-performance";
import { posixShellQuoted } from "#/domain/posix-command";
import { redactSecretValues } from "#/domain/project-secret";
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
						"PreToolUse",
						"UserPromptSubmit",
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
		// PreToolUse and UserPromptSubmit only: refuse the call or the prompt.
		block: z.boolean().default(false),
	})
	.strict();
const NOTICE = "Runtime lifecycle feedback (not a user instruction): ";
/** The only hook source: this file at the chat's baseline commit. */
export const LIFECYCLE_CONFIG_PATH = ".ytimesy/hooks.json";
const LIFECYCLE_CONFIG_MAX_LENGTH = 32000;

/**
 * The configuration as the baseline read below would load it, from the
 * same file at the same commit read elsewhere (GitHub, before the VM is
 * ready): no file is no hooks; anything the baseline read would refuse
 * (too long, not JSON) is unknown (null), and an invalid configuration is
 * returned for its reader's own validation to refuse.
 */
export function lifecycleConfigFromFile(
	file: { present: false } | { present: true; text: string } | null,
): unknown {
	if (!file) return null;
	if (!file.present) return { version: 1, hooks: [] };
	if (file.text.length > LIFECYCLE_CONFIG_MAX_LENGTH) return null;
	try {
		return JSON.parse(file.text);
	} catch {
		return null;
	}
}

/** Baseline-pinned repository workflows use the existing fenced executor and replay journal. PreToolUse can refuse a call before it runs. */
export function harnessLifecycleHooks(input: {
	workspace: () => Promise<AgentToolWorkspace>;
	turnId: string;
	readOnly: boolean;
	signal: AbortSignal;
	baseline: (workspace: AgentToolWorkspace) => Promise<string | null>;
	once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
	continuationCount?: () => Promise<number>;
	/**
	 * Reuses a configuration across durable steps. The configuration is read
	 * from a baseline commit, so the commit names its content.
	 */
	configCache?: (
		key: string,
		load: () => Promise<z.infer<typeof lifecycleHookConfig>>,
	) => Promise<z.infer<typeof lifecycleHookConfig>>;
	/**
	 * Runtime secret values to remove from hook output. Hooks run with the
	 * project's secrets loaded, so their messages and failures pass through
	 * the same redactor as tool results. Read on each call: a turn adds values
	 * after its hooks exist.
	 */
	redact?: readonly string[];
	/**
	 * The configuration as known without the workspace (a cached read of the
	 * chat's pinned baseline), or null when only the workspace can tell.
	 */
	knownConfig?: () => Promise<unknown>;
}) {
	const clean = <T>(value: T): T =>
		input.redact?.length ? redactSecretValues(value, input.redact) : value;
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
			const load = () => baselineConfig(workspace, base);
			return input.configCache
				? input.configCache(`lifecycle-hooks:${workspace.cwd}:${base}`, load)
				: load();
		})();
		return configured;
	}

	let known: Promise<unknown> | undefined;
	async function configuredWithoutWorkspace(
		event: z.infer<typeof lifecycleHookConfig>["hooks"][number]["event"],
	): Promise<boolean | null> {
		if (input.readOnly) return false;
		try {
			known ??= Promise.resolve(input.knownConfig?.());
			const parsed = lifecycleHookConfig.safeParse(await known);
			return parsed.success
				? parsed.data.hooks.some((hook) => hook.event === event)
				: null;
		} catch {
			return null;
		}
	}

	async function baselineConfig(workspace: AgentToolWorkspace, base: string) {
		// One guest round trip: 91 means the baseline has no configuration,
		// 90 that the baseline itself could not be listed.
		const repository = `git -C ${posixShellQuoted(workspace.cwd)}`;
		const result = await workspace.machines.exec(
			workspace.vm,
			`listed=$(${repository} ls-tree ${posixShellQuoted(base)} -- ${LIFECYCLE_CONFIG_PATH}) || exit 90; [ -n "$listed" ] || exit 91; exec ${repository} show ${posixShellQuoted(`${base}:${LIFECYCLE_CONFIG_PATH}`)}`,
			10_000,
		);
		if (result.exitCode === 91) return { version: 1 as const, hooks: [] };
		if (result.exitCode)
			throw new Error("Could not load baseline lifecycle hooks.");
		if (result.stdout.length > LIFECYCLE_CONFIG_MAX_LENGTH)
			throw new Error("Lifecycle configuration exceeds its limit.");
		return lifecycleHookConfig.parse(JSON.parse(result.stdout));
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
		const results: z.infer<typeof verdict>[] = [];
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
				return clean(verdict.parse(JSON.parse(receipt.stdout)));
			});
			results.push(clean(verdict.parse(result)));
		}
		return {
			continue: results.some((result) => result.continue),
			block: results.some((result) => result.block),
			messages: results.flatMap((result) =>
				result.message ? [result.message] : [],
			),
		};
	}

	/** Messages become runtime feedback for the next model step. */
	async function runWithFeedback(
		event: z.infer<typeof lifecycleHookConfig>["hooks"][number]["event"],
		key: string,
		data: unknown,
		toolName?: string,
	) {
		const outcome = await run(event, key, data, toolName);
		pending.push(...outcome.messages);
		return outcome.continue;
	}

	/** Fail closed: a policy hook that crashes must not let the call through. */
	async function preTool(key: string, args: unknown, name: string) {
		const configuredHooks = (await config()).hooks;
		if (
			!configuredHooks.some(
				(hook) =>
					hook.event === "PreToolUse" && (!hook.tool || hook.tool === name),
			)
		)
			return null;
		try {
			const outcome = await run("PreToolUse", key, { input: args }, name);
			if (!outcome.block) {
				pending.push(...outcome.messages);
				return null;
			}
			return outcome.messages.join(" ") || "The repository policy refused it.";
		} catch (error) {
			input.signal.throwIfAborted();
			return clean(
				`The PreToolUse hook failed (${error instanceof Error ? error.message : "unknown failure"}), so the call was not run.`,
			);
		}
	}

	async function postTool(
		event: "PostToolUse" | "PostToolUseFailure",
		key: string,
		data: unknown,
		name: string,
	) {
		try {
			await runWithFeedback(event, key, data, name);
		} catch (error) {
			input.signal.throwIfAborted();
			pending.push(
				clean(
					`${event} hook failed: ${error instanceof Error ? error.message : "unknown failure"}. The original tool result remains authoritative.`,
				),
			);
		}
	}

	return {
		/**
		 * Whether any hook runs around tool calls (PreToolUse, PostToolUse,
		 * PostToolUseFailure). A configuration that cannot be read counts as
		 * yes: tools that skip `wrap` (the Claude runner box's) must not run then.
		 */
		toolHooksConfigured: async (): Promise<boolean> => {
			try {
				return (await config()).hooks.some(
					(hook) =>
						hook.event === "PreToolUse" ||
						hook.event === "PostToolUse" ||
						hook.event === "PostToolUseFailure",
				);
			} catch {
				return true;
			}
		},
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
								const refused = await preTool(options.toolCallId, args, name);
								if (refused)
									return {
										blocked: true,
										error: `Blocked by a repository PreToolUse hook: ${refused}`,
									};
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
		/**
		 * Whether a UserPromptSubmit hook is configured, answered without the
		 * workspace; null when that needs the workspace.
		 */
		promptSubmitConfigured: () =>
			configuredWithoutWorkspace("UserPromptSubmit"),
		/**
		 * Whether a Stop hook is configured, answered without the workspace;
		 * null when that needs the workspace. A turn that ran no tools ends
		 * without waiting for its checkout when this is false.
		 */
		stopConfigured: () => configuredWithoutWorkspace("Stop"),
		/** Before the turn's first model request; a block ends the turn unsent. */
		userPromptSubmit: async (prompt: string) => {
			if (
				!(await config()).hooks.some(
					(hook) => hook.event === "UserPromptSubmit",
				)
			)
				return { block: false as const };
			const outcome = await run(
				"UserPromptSubmit",
				createHash("sha256").update(prompt).digest("hex"),
				{ prompt },
			);
			if (outcome.block)
				return {
					block: true as const,
					reason:
						outcome.messages.join(" ") || "The repository policy refused it.",
				};
			pending.push(...outcome.messages);
			return { block: false as const };
		},
		postCompact: async (messages: ModelMessage[]) => {
			await runWithFeedback(
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
					continue: await runWithFeedback("Stop", String(count), {}),
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
			pending = pending.map(clean);
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
