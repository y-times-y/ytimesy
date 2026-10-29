import type { ModelMessage, ToolSet } from "ai";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import {
	CODE_MODE_TOOL,
	type CodeModeResult,
} from "../../src/domain/code-mode";
import { fusionPairFor } from "../../src/domain/fusion-pairs";
import type { HarnessVariant } from "../../src/domain/harness-variant";
import { primaryCodeModeInstructions } from "../../src/domain/lean-tool-instructions";
import type { ModelProvider } from "../../src/domain/model-connection";
import { UNATTENDED_RUN_INSTRUCTIONS } from "../../src/domain/rigor";
import type { SubagentBudget, SubagentRole } from "../../src/domain/subagent";
import {
	archiveModelContext,
	type ContextArchiveStorage,
} from "../../src/server/adapters/context-archives";
import { nativeWebSearchTools } from "../../src/server/adapters/native-web-search";
import { nodePublicHost } from "../../src/server/adapters/public-host";
import { agentContextArchiveTools } from "../../src/server/services/agent-context-archive-tools";
import { agentOutputArtifacts } from "../../src/server/services/agent-output-artifacts";
import type { AgentToolWorkspace } from "../../src/server/services/agent-tool-workspace";
import { agentTurnInstructions } from "../../src/server/services/agent-turn-instructions";
import { apiAgentCommandTools } from "../../src/server/services/api-agent-command-tools";
import { apiAgentFileTools } from "../../src/server/services/api-agent-file-tools";
import { apiAgentImageTools } from "../../src/server/services/api-agent-image-tools";
import { apiAgentLanguageTools } from "../../src/server/services/api-agent-language-tools";
import { apiAgentSearchTools } from "../../src/server/services/api-agent-search-tools";
import { automaticRepositoryContext } from "../../src/server/services/automatic-repository-context";
import { batchedAgentReads } from "../../src/server/services/batched-agent-reads";
import { builderToolSurface } from "../../src/server/services/builder-shell-surface";
import {
	codeModeTool,
	primaryCodeModeTools,
} from "../../src/server/services/code-mode-tool";
import { codeToolingTools } from "../../src/server/services/code-tooling";
import { compactionStateSnapshot } from "../../src/server/services/compaction-state-snapshot";
import { dapDebuggerTools } from "../../src/server/services/dap-debugger";
import type { ModelAgentInput } from "../../src/server/services/model-agent-loop";
import { nodeDebuggerTools } from "../../src/server/services/node-debugger";
import { repositoryGuidanceTool } from "../../src/server/services/repository-guidance";
import { thinLeadTools } from "../../src/server/services/thin-lead-tools";
import { webFetchTool } from "../../src/server/services/web-fetch-tool";
import { bedrockWebSearchTools } from "./bedrock";
import {
	AGENT_WAIT_TOOL,
	HELPER_INSTRUCTIONS,
	WORKTREE_WRITER_INSTRUCTIONS,
	WRITE_HELPER_INSTRUCTIONS,
} from "./helpers";
/**
 * The product builder's turn setup (src/server/jobs/api-turn.ts) rebuilt
 * without the database: the same base tools, builderToolSurface for the
 * variant (lean by default), repository instructions as conversation
 * messages, code mode when asked, the provider's hosted web search, native
 * compaction's state snapshot, and the product's own system prompt
 * (agentTurnInstructions) for a root builder. Write-once receipts and turn
 * memos live in memory: a Harbor trial is one process, never resumed.
 *
 * Not reproduced (they need the product's database or job stack, or a
 * person): cross-chat memory, plan mode, MCP connections from the user's
 * account (task MCP servers are reached through the mcp-call helper),
 * plugins, project secrets, repository lifecycle hooks, subagents and the
 * attempt loop. Without the agent tool there is no orchestration block in
 * any prompt. Background-command exit notices are not delivered between a
 * run's steps; for the root builder, trial.ts runs a completion gate after
 * each run instead (background-gate.ts): it waits for the commands the run
 * left running and continues the session with their exit notice, as the
 * product's wake-up of an idle chat would.
 */

export type HarborWorkspace = AgentToolWorkspace & {
	signal: AbortSignal;
	sessionId: string;
	turnId: string;
};

/** In-memory write-once receipts: each tool call id runs once. */
export function memoryReceipts() {
	const receipts = new Map<string, Promise<unknown>>();
	return (id: string, run: () => Promise<unknown>) => {
		let receipt = receipts.get(id);
		if (!receipt) {
			receipt = run();
			receipts.set(id, receipt);
		}
		return receipt;
	};
}

function memoryMemo() {
	const values = new Map<string, Promise<unknown>>();
	return <T>(key: string, load: () => Promise<T>) => {
		let value = values.get(key) as Promise<T> | undefined;
		if (!value) {
			value = load();
			values.set(key, value);
		}
		return value;
	};
}

/**
 * The product's base tool set (apiAgentTools' repository tools) over the
 * Harbor workspace. A Codex subscription gets Codex's freeform apply_patch
 * and an official OpenAI endpoint the public Responses one, as in api-turn.
 *
 * `readOnly` is a read-only subagent's set (the review checker), as the
 * product's apiAgentTools with readerCommands: read-only file tools but a
 * working command runner. The product keeps the checkout safe with the
 * reader Linux user; the bridge restores the checkout after each check
 * (review.ts).
 */
export function harborBaseTools(
	workspace: HarborWorkspace,
	options: { nativePatch: boolean; freeformPatch: boolean; readOnly?: boolean },
): ToolSet {
	const once = memoryReceipts();
	const execution = {
		...workspace,
		ownerSessionId: workspace.sessionId,
		readOnly: false,
		once,
	};
	const output = agentOutputArtifacts(execution);
	const tools: ToolSet = {
		...apiAgentFileTools({
			...execution,
			readOnly: options.readOnly ?? false,
			output,
			nativePatch: options.nativePatch,
			freeformPatch: options.freeformPatch,
		}),
		...apiAgentSearchTools({ ...execution, output }),
		...apiAgentLanguageTools(execution),
		...apiAgentImageTools(execution),
		...apiAgentCommandTools({ ...execution, output }),
		...nodeDebuggerTools(execution),
		...dapDebuggerTools(execution),
		...codeToolingTools(execution),
		read_tool_output: output.readTool,
		read_repository_guidance: repositoryGuidanceTool(execution),
	};
	tools.batch_read = batchedAgentReads(tools, workspace.signal);
	return tools;
}

export type HarborHarness = {
	tools: ToolSet;
	instructions: string;
	/** ModelAgentInput hooks: repository context, archives, compaction snapshot. */
	input: Pick<
		ModelAgentInput,
		| "prepareMessages"
		| "afterTools"
		| "restoreInstructions"
		| "archiveHistory"
		| "compactionSnapshot"
		| "isUserRequest"
	>;
	leanShape: string | null;
};

/** The provider's hosted web search tool, as the bridge offers it on each route. */
export function hostedWebSearchTools(
	provider: ModelProvider | "codex-subscription",
	bedrock?: boolean,
): ToolSet {
	return bedrock
		? bedrockWebSearchTools()
		: nativeWebSearchTools(
				provider === "codex-subscription" ? "openai" : provider,
			);
}

export async function harborHarness(input: {
	workspace: HarborWorkspace;
	userId: string;
	modelId: string;
	/** The route's provider, for hosted web search and patch shape. */
	provider: ModelProvider | "codex-subscription";
	variant: HarnessVariant;
	webSearch: boolean;
	/** Web search is Bedrock's (mantle), kept inside AWS's index and cache. */
	bedrock?: boolean;
	instruction: string;
	storage: ContextArchiveStorage;
	onEvent: (event: ApiAgentEvent) => Promise<void>;
	/** A task's MCP servers, reachable through the mcp-call helper. */
	mcpNote?: string;
	/**
	 * A runtime subagent: the review loop's checker or a pair worker (read
	 * only), or lead=fusion's sidekick (role writer: it writes the lead's
	 * checkout). Web search as the trial passes it (the checker gets the
	 * builder's).
	 */
	subagent?: { role: SubagentRole; budget: SubagentBudget; readOnly: boolean };
	/**
	 * Tools the trial adds on top of the surface, before the prompt is built:
	 * the fusion lead's agent/agent_send, a pair judge's checker_worker.
	 */
	extraTools?: (tools: ToolSet) => ToolSet;
	/**
	 * The trial's own tools (ledger=on's requirements, goal=on's goal tool):
	 * direct tools that run_code programs may call too, kept for a thin lead.
	 */
	trialTools?: ToolSet;
	/** search=function: the plain web_search tool that replaces the hosted one. */
	searchTool?: ToolSet;
}): Promise<HarborHarness> {
	const { workspace, variant } = input;
	const memo = memoryMemo();
	const leanOnce = memoryReceipts();
	const subscription = input.provider === "codex-subscription";
	// The checker is a reader: read-only files, a working command runner and
	// a lean surface without write and edit (builderToolSurface readOnly).
	const readOnly = input.subagent?.readOnly ?? false;
	const base = harborBaseTools(workspace, {
		nativePatch: input.provider === "openai",
		freeformPatch: subscription,
		readOnly,
	});
	const archiveTools = agentContextArchiveTools({
		userId: input.userId,
		sessionId: workspace.sessionId,
		signal: workspace.signal,
		storage: input.storage,
	});
	const repositoryContext = automaticRepositoryContext({
		tools: { ...base, ...archiveTools },
		workspace: async () => workspace,
		signal: workspace.signal,
		// Builders get repository instructions as messages, like AGENTS.md in Codex.
		instructionMessages: { turnStart: true },
		onEvent: input.onEvent,
	});
	const surface = builderToolSurface({
		variant: variant.toolSurface,
		modelId: input.modelId,
		tools: repositoryContext.tools,
		readOnly,
		lean: {
			workspace: async () => workspace,
			sessionId: workspace.sessionId,
			turnId: workspace.turnId,
			signal: workspace.signal,
			once: (requestId, _fingerprint, run) => leanOnce(requestId, run),
			memo,
		},
	});
	// search=function: the trial's plain web_search tool in place of the
	// provider's hosted one (its call makes its own hosted-search request).
	const webSearch = input.webSearch
		? variant.search === "function" && input.searchTool
			? input.searchTool
			: hostedWebSearchTools(input.provider, input.bedrock)
		: {};
	const trialTools = input.trialTools ?? {};
	const helperInstructions =
		AGENT_WAIT_TOOL in trialTools
			? variant.helpers === "write"
				? WRITE_HELPER_INSTRUCTIONS
				: variant.helpers === "write-tree"
					? WORKTREE_WRITER_INSTRUCTIONS
					: HELPER_INSTRUCTIONS
			: "";
	// fetch=on: web_fetch for every agent, fetched here on the harness side
	// (not in the task container), on any route.
	const fetchTools: ToolSet =
		variant.fetch === "on" ? webFetchTool({ checkHost: nodePublicHost }) : {};
	let tools: ToolSet = {
		...surface.tools,
		...webSearch,
		...fetchTools,
		...trialTools,
	};
	// Code mode on a lean surface, as api-turn's withCodeMode. primary has no
	// deferred tools here: the trial's own tools (helpers=on's agent tools,
	// plan=on's update_plan) and fetch=on's web_fetch are direct tools that
	// programs may call too.
	// lead=fusion's thin lead (leadTools=thin): delegation, a capped read and
	// a bounded inspection command only (thin-lead-tools.ts), as the product's.
	const thinLead =
		!input.subagent &&
		variant.lead === "fusion" &&
		variant.leadTools === "thin" &&
		!!surface.lean;
	const codeMode =
		surface.lean && variant.codeMode !== "off" && !thinLead
			? variant.codeMode
			: null;
	if (codeMode) {
		const journal = new Map<string, CodeModeResult>();
		const runCode = codeModeTool({
			tools,
			signal: workspace.signal,
			sessionId: workspace.sessionId,
			turnId: workspace.turnId,
			mode: codeMode,
			deferred: [],
			callable: [
				...Object.keys(fetchTools),
				...Object.keys(trialTools),
				...(variant.search === "function" && input.webSearch
					? Object.keys(input.searchTool ?? {})
					: []),
			],
			journal: (toolCallId) => ({
				recorded: async () => journal.get(toolCallId),
				record: async (result) => {
					journal.set(toolCallId, result);
				},
			}),
		});
		if (runCode)
			tools =
				codeMode === "primary"
					? primaryCodeModeTools({ [CODE_MODE_TOOL]: runCode }, tools)
					: { ...tools, [CODE_MODE_TOOL]: runCode };
	}
	if (input.extraTools) tools = { ...tools, ...input.extraTools(tools) };
	if (thinLead) tools = { ...thinLeadTools(tools), ...trialTools };
	const fullInstructions = agentTurnInstructions({
		session: input.subagent
			? {
					agentRole: input.subagent.role,
					agentBudget: input.subagent.budget,
				}
			: {},
		lead: variant.lead,
		// leadTools=full keeps the earlier bridge prompt unchanged (no pair tuning).
		...(thinLead
			? {
					leadTools: "thin" as const,
					leadBlocking: true,
					fusionPair: fusionPairFor(input.modelId, variant.roleModels),
				}
			: {}),
		rigor: variant.rigor === "on",
		tools,
		plugins: [],
		projectKnowledge: null,
		leanShape: surface.lean?.shape,
		leanReadOnly: surface.lean?.readOnly,
		leanWorkingDirectory: surface.lean ? workspace.cwd : undefined,
		codeMode: codeMode && CODE_MODE_TOOL in tools ? codeMode : undefined,
		// Only the root builder: a subagent's brief already names what to report.
		unattended: !input.subagent,
		checkInProportion: variant.checks === "proportion",
		...(helperInstructions ? { helperInstructions } : {}),
	});
	// prompt=minimal (root builder only): no rule blocks, to measure what
	// they cost in thinking.
	const instructions =
		variant.prompt === "minimal" && !input.subagent && surface.lean
			? [
					`You are a coding agent working in the repository checkout at ${workspace.cwd}; commands start there. Do the task yourself, end to end.`,
					codeMode === "primary"
						? primaryCodeModeInstructions(surface.lean.shape)
						: "",
					helperInstructions,
					"Your final answer is brief (at most 10 lines): what you delivered and how you checked it.",
				]
					.filter(Boolean)
					.join("\n")
			: fullInstructions;
	return {
		tools,
		// The root builder of a trial: nobody answers its questions.
		instructions: `${instructions}${input.subagent ? "" : `\n${UNATTENDED_RUN_INSTRUCTIONS}`}${input.mcpNote ?? ""}`,
		leanShape: surface.lean?.shape ?? null,
		input: {
			prepareMessages: repositoryContext.prepare,
			afterTools: repositoryContext.afterTools,
			restoreInstructions: repositoryContext.restoreInstructions,
			archiveHistory: async (history: ModelMessage[]) => {
				const reference = await archiveModelContext(
					input.userId,
					workspace.sessionId,
					history,
					input.storage,
				);
				// A lean surface has no archive tools: it searches a file instead.
				const file = await surface.lean?.saveHistory(reference, history);
				return file ? { file } : reference;
			},
			compactionSnapshot: compactionStateSnapshot({
				workspace: async () => workspace,
			}),
			isUserRequest: (message: ModelMessage) =>
				message.role === "user" && message.content === input.instruction,
		},
	};
}
