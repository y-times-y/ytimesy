import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentOutputArtifacts } from "../src/server/services/agent-output-artifacts";
import { apiAgentCommandTools } from "../src/server/services/api-agent-command-tools";
import {
	commandScopeRoot,
	stopApiTurnCommands,
} from "../src/server/services/api-command-scope";
import { localHarnessWorkspace } from "../tests/helpers/local-harness-workspace";

assert.equal(process.platform, "linux");
const fixture = await localHarnessWorkspace();
const sessionId = randomUUID(),
	turnId = randomUUID();
const input = {
	...fixture.workspace,
	sessionId,
	turnId,
	readOnly: false,
	signal: new AbortController().signal,
	once: (() => {
		const receipts = new Map<string, Promise<unknown>>();
		return (id: string, execute: () => Promise<unknown>) => {
			const previous = receipts.get(id);
			if (previous) return previous;
			const pending = execute();
			receipts.set(id, pending);
			return pending;
		};
	})(),
};
const output = agentOutputArtifacts(input);
const tools = apiAgentCommandTools({ ...input, output });
const call = (name: string, args: object, toolCallId = randomUUID()) => {
	const execute = tools[name]?.execute;
	if (!execute) throw new Error(`Missing ${name}`);
	return execute(args, { toolCallId, messages: [], context: {} }) as Promise<{
		id: string;
		status: number | string;
		stdout: string;
		nextStart: number | null;
	}>;
};
const passed: string[] = [];
try {
	const immediate = await call("execute_command", {
		command: "printf immediate",
		yieldSeconds: 2,
		maxSeconds: 30,
	});
	assert.equal(immediate.status, 0);
	assert.equal(immediate.stdout, "immediate");
	passed.push("Immediate result");
	const runId = randomUUID();
	const started = await call(
		"execute_command",
		{
			command: `printf x >> starts; python3 -u -c 'value=input(); print("GOT:"+value)'`,
			maxSeconds: 30,
			yieldSeconds: 1,
		},
		runId,
	);
	assert.equal(started.status, "running");
	const replay = await call(
		"execute_command",
		{ command: "must not execute", yieldSeconds: 0, maxSeconds: 30 },
		runId,
	);
	assert.equal(replay.id, started.id);
	const finished = await call("continue_command", {
		id: started.id,
		chars: "literal '; $(never-run)\n",
		seconds: 2,
	});
	assert.equal(finished.status, 0);
	assert.match(finished.stdout, /GOT:literal '; \$\(never-run\)/);
	assert.equal(await readFile(join(fixture.root, "starts"), "utf8"), "x");
	passed.push("Yield, literal stdin, same-id replay, no duplicate execution");
	const eof = await call("execute_command", {
		command: `python3 -u -c 'import sys; print(len(sys.stdin.read())); sys.exit(3)'`,
		yieldSeconds: 1,
		maxSeconds: 30,
	});
	const eofResult = await call("continue_command", {
		id: eof.id,
		eof: true,
		seconds: 2,
	});
	assert.equal(eofResult.status, 3);
	assert.equal(eofResult.stdout.trim(), "0");
	passed.push("EOF and real failed exit");
	const foreign = apiAgentCommandTools({
		...input,
		sessionId: randomUUID(),
		output,
	});
	const foreignContinue = foreign.continue_command.execute;
	if (!foreignContinue) throw new Error("Missing continuation");
	await assert.rejects(async () =>
		foreignContinue(
			{ id: eof.id, chars: "blocked" },
			{ toolCallId: randomUUID(), messages: [], context: {} },
		),
	);
	passed.push("Cross-session input rejected");
	const cancelled = await call("execute_command", {
		command: "sleep 20; touch MUST_NOT_EXIST",
		yieldSeconds: 0,
		maxSeconds: 30,
	});
	const sibling = await call("execute_command", {
		command: "sleep 2; printf sibling",
		maxSeconds: 30,
		yieldSeconds: 0,
	});
	await call("stop_command", { id: cancelled.id });
	const stopped = await call("continue_command", {
		id: cancelled.id,
		seconds: 0,
	});
	assert.notEqual(stopped.status, 0);
	await assert.rejects(readFile(join(fixture.root, "MUST_NOT_EXIST")));
	passed.push("Owned cancellation");
	const siblingResult = await call("continue_command", {
		id: sibling.id,
		seconds: 4,
	});
	assert.equal(siblingResult.status, 0);
	assert.equal(siblingResult.stdout, "sibling");
	passed.push("Sibling command survives cancellation");
	const noWrite = apiAgentCommandTools({ ...input, readOnly: true, output });
	assert.equal(noWrite.execute_command, undefined);
	assert.equal(noWrite.continue_command, undefined);
	passed.push("Read-only boundary");
	console.log(
		JSON.stringify({ linux: true, inference: false, passed }, null, 2),
	);
} finally {
	await stopApiTurnCommands(fixture.workspace, turnId);
	await fixture.cleanup();
	await rm(commandScopeRoot(turnId), { recursive: true, force: true });
	await rm(`/tmp/ytimesy-api-commands/${sessionId}`, {
		recursive: true,
		force: true,
	});
	await rm(output.directory, { recursive: true, force: true });
}
