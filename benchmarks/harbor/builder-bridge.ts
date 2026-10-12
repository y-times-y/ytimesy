/**
 * Runs the ytimesy builder (the v13 shell profile we benchmark) inside a
 * Harbor trial. Harbor owns the sandbox: every command the builder runs is
 * sent to the Python agent over stdout and executed with Harbor's own
 * environment.exec, so the task, timeouts and grading are Harbor's.
 *
 * Protocol: requests are single lines on stdout prefixed with REQUEST;
 * responses arrive as JSON lines on stdin. Logs go to stderr.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import { WorkspaceId } from "../../src/domain/ids";
import { posixShellQuoted as quote } from "../../src/domain/posix-command";
import { runModelAgent } from "../../src/server/services/model-agent-loop";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";
import { evaluationBuilderContext } from "../evaluation/builder-context";
import { evaluationBuilderTools } from "../evaluation/builder-tools";
import { localContextArchives } from "../evaluation/local-context-archives";
import { estimatedSolCostUsd, openAiSolRuntime } from "../evaluation/openai-sol";
import { evaluationTokenUsage } from "../evaluation/token-usage";

const REQUEST = "@@YTIMESY_HARBOR@@";
const { instruction, cwd, logsDir, timeoutSeconds } = JSON.parse(
	process.argv[2] ?? "{}",
) as {
	instruction: string;
	cwd: string;
	logsDir: string;
	timeoutSeconds: number;
};

type Reply = { id: number; exitCode: number; stdout?: string; stderr?: string };
const pending = new Map<number, (reply: Reply) => void>();
let nextId = 1;
createInterface({ input: process.stdin }).on("line", (line) => {
	const reply = JSON.parse(line) as Reply;
	pending.get(reply.id)?.(reply);
	pending.delete(reply.id);
});
const harborExec = (command: string, timeoutMs: number) =>
	new Promise<Reply>((resolve) => {
		const id = nextId++;
		pending.set(id, resolve);
		process.stdout.write(
			`${REQUEST}${JSON.stringify({ id, op: "exec", command, timeoutMs })}\n`,
		);
	});

// Only the three operations the builder tools use; files travel as base64.
const machines = {
	exec: async (_vm: WorkspaceId, command: string, timeoutMs = 120_000) => {
		const reply = await harborExec(command, timeoutMs);
		return {
			exitCode: reply.exitCode,
			stdout: reply.stdout ?? "",
			stderr: reply.stderr ?? "",
		};
	},
	readTextFile: async (_vm: WorkspaceId, path: string) => {
		const reply = await harborExec(
			`test -f ${quote(path)} && base64 < ${quote(path)} | tr -d '\\n'`,
			30_000,
		);
		return reply.exitCode
			? null
			: Buffer.from((reply.stdout ?? "").trim(), "base64").toString("utf8");
	},
	writeTextFile: async (_vm: WorkspaceId, path: string, contents: string) => {
		const reply = await harborExec(
			`mkdir -p "$(dirname ${quote(path)})" && printf %s ${Buffer.from(contents).toString("base64")} | base64 -d > ${quote(path)}`,
			30_000,
		);
		if (reply.exitCode) throw new Error(`Could not write ${path}.`);
	},
} as unknown as WorkspaceMachines;

const SHELL_TOOLS = new Set([
	"execute_command",
	"continue_command",
	"stop_command",
	"apply_patch",
	"view_image",
	"read_repository_guidance",
]);

await mkdir(logsDir, { recursive: true });
const sessionId = randomUUID();
const events: ApiAgentEvent[] = [];
const signal = AbortSignal.timeout(timeoutSeconds * 1000);
const workspace = {
	machines,
	vm: WorkspaceId("harbor"),
	cwd,
	signal,
	sessionId,
	turnId: randomUUID(),
};
const builderTools = evaluationBuilderTools(workspace, { nativePatch: true });
const archives = localContextArchives(
	`${logsDir}/context-archives`,
	"harbor",
	sessionId,
);
const context = evaluationBuilderContext({
	tools: Object.fromEntries(
		Object.entries(builderTools).filter(([name]) => SHELL_TOOLS.has(name)),
	),
	storage: archives.storage,
	workspace,
	userId: "harbor",
	sessionId,
	signal,
	onEvent: async (event) => {
		events.push(event);
	},
});
const runtime = await openAiSolRuntime({
	modelId: "gpt-6.1-sol",
	effort: "max",
	cacheScope: sessionId,
});
let failure: string | null = null;
try {
	await runModelAgent(
		{
			userId: "harbor",
			modelId: "gpt-6.1-sol",
			reasoning: "max",
			toolSurface: "implementation",
			...context,
			signal,
			maxSteps: 400,
			turnTimeoutMs: timeoutSeconds * 1000,
			messages: [{ role: "user", content: instruction }],
			// Identical to the builder evaluator's instructions.
			instructions:
				"You are the ytimesy builder. Complete the user's task in /app. Use the repository tools for inspection, editing and verification. Read applicable repository guidance before editing. Do not publish, delegate, or access another project. Report the actual checks and any unresolved problems.",
			onEvent: async (event) => {
				events.push(event);
				// Progress for operators: one stderr line per tool call and usage update.
				if (event.type === "tool-call")
					process.stderr.write(
						`tool ${event.name} ${JSON.stringify(event.input).slice(0, 160)}\n`,
					);
				if (event.type === "usage")
					process.stderr.write(
						`usage in=${event.usage.inputTokens} out=${event.usage.outputTokens}\n`,
					);
			},
			onStep: async () => {},
		},
		runtime,
	);
} catch (error) {
	failure = error instanceof Error ? error.message : "Builder failed";
}
const usage = evaluationTokenUsage(events);
await writeFile(`${logsDir}/ytimesy-trace.json`, JSON.stringify({ events }));
process.stdout.write(
	`${REQUEST}${JSON.stringify({
		op: "done",
		failure,
		inputTokens: usage?.inputTokens ?? null,
		cachedTokens: usage?.cacheReadTokens ?? null,
		outputTokens: usage?.outputTokens ?? null,
		costUsd: estimatedSolCostUsd(usage),
	})}\n`,
);
process.exit(0);
