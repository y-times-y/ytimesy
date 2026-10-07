import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentToolWorkspace } from "../../src/server/services/agent-tool-workspace";
import { apiAgentFileTools } from "../../src/server/services/api-agent-file-tools";
import { apiAgentLanguageTools } from "../../src/server/services/api-agent-language-tools";
import { codeToolingTools } from "../../src/server/services/code-tooling";
import { dapDebuggerTools } from "../../src/server/services/dap-debugger";

type ProofResult = {
	prepared: { available: boolean }[];
	result: { index: number; sha256: string }[];
	results: { result: unknown[] }[];
	debuggerId: string;
	status: string;
	pauseId: string;
	frames: { id: number; line: number }[];
	scopes: { name: string; reference: number }[];
	variables: { name: string; value: string }[];
};

/** Zero-inference assertions on a separate checkout; no task solution enters agent context. */
export async function proveOmpGuestCapabilities(
	workspace: AgentToolWorkspace,
	signal: AbortSignal,
	onStage: (stage: string) => void = () => {},
) {
	const sessionId = randomUUID();
	const input = {
		...workspace,
		signal,
		ownerSessionId: sessionId,
		turnId: randomUUID(),
		readOnly: false,
		once: async (_id: string, run: () => Promise<unknown>) => run(),
	};
	const tools: ToolSet = {
		...apiAgentFileTools(input),
		...apiAgentLanguageTools(input),
		...codeToolingTools(input),
		...dapDebuggerTools(input),
	};
	const invoke = async (name: string, args: unknown) => {
		signal.throwIfAborted();
		const execute = tools[name]?.execute;
		if (!execute) throw new Error(`Missing capability ${name}`);
		const schema = tools[name].inputSchema;
		if (!(schema instanceof z.ZodType))
			throw new Error("Proof tool requires a Zod schema");
		return (await execute(schema.parse(args), {
			toolCallId: randomUUID(),
			messages: [],
			context: undefined,
		})) as ProofResult;
	};
	const write = (path: string, content: string) =>
		workspace.machines.writeTextFile(
			workspace.vm,
			`${workspace.cwd}/${path}`,
			content,
		);
	const setup = await workspace.machines.exec(
		workspace.vm,
		`mkdir -p '${workspace.cwd}' && git -C '${workspace.cwd}' init -q`,
		15000,
	);
	assert.equal(setup.exitCode, 0);
	await write("index.ts", "export const answer = 42;\n");
	await write(
		"usage.ts",
		'import { answer } from "./index";\nconsole.log(answer);\n',
	);
	await write(
		"tsconfig.json",
		'{"compilerOptions":{"strict":true,"module":"commonjs"}}',
	);
	await write(
		"main.py",
		"counter = 41\nlabel = 'before'\ncounter += 1\nlabel = 'after'\nprint(counter, label)\n",
	);
	onStage("prepare Python language/debugger");
	const prepared = await invoke("prepare_code_tools", {
		runtime: "python",
		debugger: true,
	});
	assert.ok(prepared.prepared.every((item) => item.available));
	onStage("outline, file move and code action");
	const outline = await invoke("read_code", {
		files: [{ path: "main.py", view: "outline" }],
	});
	assert.ok(JSON.stringify(outline).includes("sha256"));
	await invoke("rename_file", { path: "index.ts", newPath: "moved.ts" });
	assert.ok(
		(
			await workspace.machines.readTextFile(
				workspace.vm,
				`${workspace.cwd}/usage.ts`,
			)
		)?.includes("./moved"),
	);
	await write(
		"actions.ts",
		'import { z } from "./z";\nimport { a } from "./a";\nexport const both = [z, a];\n',
	);
	await write("z.ts", "export const z=1;");
	await write("a.ts", "export const a=2;");
	const actions = await invoke("inspect_code", {
		path: "actions.ts",
		operation: "code_actions",
		line: 1,
		column: 1,
		kind: "source.organizeImports",
	});
	const choices = actions.result;
	assert.ok(Array.isArray(choices) && choices.length > 0);
	await invoke("apply_code_action", {
		path: "actions.ts",
		operation: "code_actions",
		line: 1,
		column: 1,
		kind: "source.organizeImports",
		actionIndex: choices[0].index,
		actionSha256: choices[0].sha256,
	});
	onStage("warm LSP batch");
	const batch = await invoke("inspect_code_batch", {
		requests: [
			{ path: "moved.ts", operation: "references", line: 1, column: 14 },
			{ path: "moved.ts", operation: "hover", line: 1, column: 14 },
		],
	});
	assert.equal(batch.results.length, 2);
	assert.ok(batch.results[0].result.length >= 2);
	onStage("Python DAP launch/breakpoint/locals/step");
	let state = await invoke("debug_program", {
		action: "start",
		adapter: "python",
		path: "main.py",
		arguments: [],
		breakpoints: [{ path: "main.py", lines: [3] }],
	});
	const debuggerId = state.debuggerId;
	assert.equal(typeof debuggerId, "string");
	try {
		for (let n = 0; n < 20 && state.status !== "paused"; n++)
			state = await invoke("debug_program", { action: "stack", debuggerId });
		assert.equal(state.status, "paused");
		state = await invoke("debug_program", { action: "continue", debuggerId });
		for (let n = 0; n < 20 && state.frames[0]?.line !== 3; n++)
			state = await invoke("debug_program", { action: "stack", debuggerId });
		assert.equal(state.frames[0].line, 3);
		const pauseId = state.pauseId,
			scopes = await invoke("debug_program", {
				action: "scopes",
				debuggerId,
				frameId: state.frames[0].id,
				pauseId,
			});
		const local = scopes.scopes.find((item) => /local/i.test(item.name));
		assert.ok(local, "Paused Python frame has a locals scope");
		const reference = local.reference;
		const variables = await invoke("debug_program", {
			action: "variables",
			debuggerId,
			reference,
			pauseId,
		});
		assert.equal(
			variables.variables.find((item) => item.name === "counter")?.value,
			"41",
		);
		state = await invoke("debug_program", { action: "step_over", debuggerId });
		assert.equal(state.frames[0].line, 4);
		await assert.rejects(
			invoke("debug_program", {
				action: "variables",
				debuggerId,
				reference,
				pauseId,
			}),
		);
	} finally {
		await invoke("debug_program", { action: "stop", debuggerId });
	}
	return {
		pythonPreparation: "passed",
		persistentServiceAndWarmLsp: "passed",
		outline: "passed",
		fileMoveImports: "passed",
		organizeImports: "passed",
		pythonDapBreakpointLocalsStepAndStaleFence: "passed",
		inferenceRequests: 0,
	};
}
