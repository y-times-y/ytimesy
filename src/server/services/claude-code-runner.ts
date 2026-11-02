import type { ModelMessage } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import {
	ClaudeCodeApiUnavailable,
	ClaudeCodeRunFailure,
	ClaudeSubscriptionLimitReached,
	ClaudeSubscriptionRefused,
} from "#/domain/api-turn-failure";
import { issueClaudeCodeGrant } from "#/domain/claude-code-grant";
import { CLAUDE_CODE_PROXY_PREFIX } from "#/domain/claude-code-proxy";
import {
	CLAUDE_CODE_MCP_SERVER,
	type ClaudeCodePlanStep,
	type ClaudeCodeResult,
	claudeCodeEffects,
	claudeCodeFailure,
	claudeCodeProjectDirectory,
	claudeCodePrompt,
	isClaudeCodeSessionId,
} from "#/domain/claude-code-stream";
import {
	CLAUDE_CODE_BINARY,
	claudeCodeInstallScript,
} from "#/domain/guest-cli-pin";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { redactSecretValues } from "#/domain/project-secret";
import {
	READER_LINUX_USER,
	readerNetworkedCommand,
	readerScratchDirectory,
} from "#/domain/subagent-reader";
import type {
	ClaudeCodeSessionRecord,
	ClaudeSubscriptionStatus,
} from "../adapters/claude-subscription";
import {
	COMMAND_STOP_SCRIPT,
	commandScopeRoot,
	scopedShellCommand,
} from "./api-command-scope";

/**
 * One durable step of a Claude Code turn: the unmodified CLI runs detached
 * on the chat's VM (`claude -p --output-format stream-json`), and each step
 * reads what it wrote since the last one, maps it into the chat's timeline,
 * and either yields at its deadline (the CLI keeps running; the next step
 * re-attaches) or ends when the CLI reports its result. The process runs in
 * the turn's command scope, so stopping the turn stops it.
 *
 * The VM never holds the user's token: CLAUDE_CODE_OAUTH_TOKEN is a signed
 * per-turn grant and ANTHROPIC_BASE_URL is the edge proxy that swaps the
 * real token in. Each run's session JSONL is saved after it ends, so a
 * later turn on a new machine resumes the same Claude Code session.
 */
export type ClaudeCodeShell = (
	command: string,
	timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type ClaudeCodeStore = {
	readonly readSession: () => Promise<ClaudeCodeSessionRecord | null>;
	readonly saveSession: (record: ClaudeCodeSessionRecord) => Promise<void>;
	readonly uploadTranscript: (
		claudeSessionId: string,
		text: string,
	) => Promise<string>;
	readonly downloadTranscript: (path: string) => Promise<string>;
	readonly subscriptionStatus: () => Promise<ClaudeSubscriptionStatus>;
};

export type ClaudeCodeStepInput = {
	/** Runs a command on the VM as its default (builder) user. */
	readonly shell: ClaudeCodeShell;
	/** Writes and reads a file as the default user (transcript restore and save). */
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	readonly readFile: (path: string) => Promise<string | null>;
	readonly cwd: string;
	readonly userId: string;
	readonly sessionId: string;
	readonly turnId: string;
	/** Claude Code's --model. */
	readonly modelId: string;
	readonly messages: readonly ModelMessage[];
	/** The edge's public origin (the git proxy's), which the VM reaches. */
	readonly edgeOrigin: string;
	readonly grantSecret: string;
	/** A read-only helper: the CLI runs as the reader user, without write tools. */
	readonly reader: boolean;
	/** Isolates the reader on this VM before its first command. */
	readonly prepareReader?: () => Promise<void>;
	/** When this step yields to the next one (epoch ms). */
	readonly deadline: number;
	readonly signal: AbortSignal;
	readonly redact: () => readonly string[];
	/** Adds a value (the run's grant) to the turn's redaction list. */
	readonly addRedaction?: (value: string) => void;
	readonly hasItem: (id: string) => boolean;
	readonly toolName: (id: string) => string | undefined;
	readonly onEvent: (event: ApiAgentEvent) => Promise<void>;
	readonly onPlan: (plan: readonly ClaudeCodePlanStep[]) => void;
	/** ytimesy's MCP tools: runs queued calls, says whether any still run, waits for one. */
	readonly bridge: {
		readonly pump: () => void;
		readonly busy: () => boolean;
		readonly wait: (ms: number) => Promise<void>;
	};
	readonly store: ClaudeCodeStore;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
};

export type ClaudeCodeStepResult = {
	readonly messages: ModelMessage[];
	readonly outcome: "continue" | "completed";
};

const RUNS = ".ytimesy/claude-runs";
const CONFIG = ".ytimesy/claude-code";
const READ_LIMIT = 512 * 1024;
const PROCESS_SECONDS = 6 * 60 * 60;
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
/** Base64 per exec: well inside the VM's 64 KiB command limit. */
const WRITE_CHUNK = 36 * 1024;
const POLL_MIN_MS = 500;
const POLL_MAX_MS = 2_000;
const BUSY_GRACE_MS = 30_000;

/**
 * Reports a run's state and the complete lines since its saved offset,
 * after saving the offset the runner finished (argv: run dir, offset to
 * save or -1, byte limit). Header line: {"offset","next","status","size"};
 * then one "<byte offset>\t<line>" per line. A line longer than the limit
 * is skipped and reported as {"type":"ytimesy_oversize"}.
 */
const POLL_SCRIPT = `import json,os,sys
d,commit,limit=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
if commit>=0:
    t=os.path.join(d,'offset.tmp'); open(t,'w').write(str(commit)); os.replace(t,os.path.join(d,'offset'))
try: off=int(open(os.path.join(d,'offset')).read().strip() or 0)
except FileNotFoundError: off=0
try: status=open(os.path.join(d,'status')).read().strip() or None
except FileNotFoundError: status=None
out=os.path.join(d,'out'); lines=[]; nxt=off
try:
    size=os.path.getsize(out)
    with open(out,'rb') as f:
        f.seek(off); data=f.read(limit)
        end=data.rfind(b'\\n')
        if end>=0:
            pos=off
            for raw in data[:end+1].split(b'\\n')[:-1]:
                lines.append((pos,raw.decode('utf-8','replace'))); pos+=len(raw)+1
            nxt=off+end+1
        elif len(data)==limit:
            skipped=len(data); found=False
            while not found:
                more=f.read(1<<20)
                if not more: break
                i=more.find(b'\\n')
                if i>=0: skipped+=i+1; found=True
                else: skipped+=len(more)
            if found:
                lines.append((off,json.dumps({'type':'ytimesy_oversize'}))); nxt=off+skipped
except FileNotFoundError: size=0
print(json.dumps({'offset':off,'next':nxt,'status':status,'size':size}))
for pos,line in lines: print(str(pos)+'\\t'+line)`;

type RunState = {
	readonly run: number | null;
	readonly consumed: boolean;
	readonly sessionId: string | null;
};

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function checked(
	shell: ClaudeCodeShell,
	command: string,
	failure: string,
	timeoutMs = 30_000,
) {
	const result = await shell(command, timeoutMs);
	if (result.exitCode !== 0) throw new ClaudeCodeRunFailure(failure);
	return result.stdout;
}

/** Writes a file through the shell in bounded chunks (mode 0600, under umask 077). */
async function writeThroughShell(
	shell: ClaudeCodeShell,
	path: string,
	contents: string,
) {
	const encoded = Buffer.from(contents, "utf8").toString("base64");
	if (!encoded.length) {
		await checked(
			shell,
			`umask 077; : > ${quote(path)}`,
			"could not write its input.",
		);
		return;
	}
	for (let start = 0; start < encoded.length; start += WRITE_CHUNK) {
		const chunk = encoded.slice(start, start + WRITE_CHUNK);
		await checked(
			shell,
			`umask 077; printf %s ${quote(chunk)} | base64 -d ${start ? ">>" : ">"} ${quote(path)}`,
			"could not write its input.",
		);
	}
}

function systemPrompt(cwd: string, reader: boolean) {
	return [
		"You are running inside ytimesy, on this chat's own cloud machine.",
		`The repository is at ${cwd}.`,
		`ytimesy adds tools as mcp__${CLAUDE_CODE_MCP_SERVER}__*: "agent" starts a helper agent (a writer gets its own machine; read-only helpers share this one) and its report comes back to you; "request_project_secret" asks the user for a secret; "ask_user" asks the user a question (end your turn after asking). Your TodoWrite list is shown to the user.`,
		reader
			? "You are a read-only helper: do not change files; report what you find."
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

export async function runClaudeCodeStep(
	input: ClaudeCodeStepInput,
): Promise<ClaudeCodeStepResult> {
	const now = input.now ?? Date.now;
	const sleep = input.sleep ?? input.bridge.wait;
	const { shell, turnId } = input;
	if (!/^[a-f0-9-]{36}$/.test(turnId)) throw new Error("Invalid turn id.");
	input.signal.throwIfAborted();
	const home = (
		await checked(
			shell,
			'printf %s "$HOME"',
			"could not read the machine's home.",
		)
	).trim();
	if (!home.startsWith("/"))
		throw new ClaudeCodeRunFailure("the machine has no home directory.");
	const turnDirectory = `${home}/${RUNS}/${turnId}`;
	const state = await readRunState(shell, turnDirectory);
	let run = state.run;
	let claudeSessionId = state.sessionId;
	if (run === null || state.consumed) {
		const launched = await launchRun(
			input,
			home,
			turnDirectory,
			(run ?? 0) + 1,
			claudeSessionId,
		);
		if (!launched)
			return { messages: [...input.messages], outcome: "completed" };
		run = launched.run;
	}
	const runDirectory = `${turnDirectory}/${run}`;
	let commit = -1;
	let wait = POLL_MIN_MS;
	/** Claude Code's own API error line (never shown): why the run is failing. */
	let apiError: string | null = null;
	for (;;) {
		input.signal.throwIfAborted();
		input.bridge.pump();
		const poll = await shell(
			`python3 -c ${quote(POLL_SCRIPT)} ${quote(runDirectory)} ${commit} ${READ_LIMIT}`,
			30_000,
		);
		if (poll.exitCode !== 0)
			throw new ClaudeCodeRunFailure("its output could not be read.");
		const [headerLine = "", ...lines] = poll.stdout.split("\n");
		const header = parseJson(headerLine) as {
			offset?: number;
			next?: number;
			status?: string | null;
			size?: number;
		} | null;
		if (!header || typeof header.next !== "number")
			throw new ClaudeCodeRunFailure("its output could not be read.");
		commit = -1;
		let result: ClaudeCodeResult | null = null;
		for (const entry of lines) {
			if (!entry) continue;
			const tab = entry.indexOf("\t");
			if (tab <= 0) continue;
			const key = entry.slice(0, tab);
			const line = entry.slice(tab + 1);
			for (const effect of claudeCodeEffects(line, key, {
				toolName: input.toolName,
			})) {
				if (effect.kind === "session") {
					claudeSessionId = effect.sessionId;
					if (effect.failedMcpServers.includes(CLAUDE_CODE_MCP_SERVER))
						console.warn("Claude Code could not connect to ytimesy's tools.");
				} else if (effect.kind === "plan") input.onPlan(effect.plan);
				else if (effect.kind === "api-error") apiError = effect.text;
				else if (effect.kind === "result") result = effect.result;
				else await emit(input, effect.event);
			}
		}
		if (header.next !== header.offset) commit = header.next;
		if (result) {
			await finishRun(shell, runDirectory, commit);
			const sessionId = result.sessionId ?? claudeSessionId;
			if (sessionId && isClaudeCodeSessionId(sessionId))
				await saveTranscript(input, home, sessionId).catch((error: unknown) =>
					console.warn("Claude Code transcript was not saved.", {
						message:
							error instanceof Error ? error.message.slice(0, 200) : "unknown",
					}),
				);
			return completeRun(input, result, home, apiError);
		}
		const exited =
			typeof header.status === "string" &&
			header.next === header.offset &&
			header.next === header.size;
		if (exited) {
			await finishRun(shell, runDirectory, commit);
			throw await exitFailure(
				input,
				runDirectory,
				header.status as string,
				apiError,
			);
		}
		// Yield at the deadline, never with a ytimesy tool call still answering.
		const due = now() + wait >= input.deadline;
		// A tool call still answering holds the step a little past its
		// deadline; it never holds it past the executor's own budget.
		if (
			due &&
			(!input.bridge.busy() || now() >= input.deadline + BUSY_GRACE_MS)
		) {
			if (commit >= 0)
				await shell(
					`python3 -c ${quote(POLL_SCRIPT)} ${quote(runDirectory)} ${commit} 0`,
					30_000,
				).catch(() => undefined);
			return { messages: [...input.messages], outcome: "continue" };
		}
		if (lines.some(Boolean)) wait = POLL_MIN_MS;
		else {
			await sleep(wait);
			wait = Math.min(POLL_MAX_MS, wait * 2);
		}
	}
}

async function emit(input: ClaudeCodeStepInput, event: ApiAgentEvent) {
	// A re-read line (a step restarted) must not append its text twice.
	if (
		(event.type === "text-delta" || event.type === "reasoning-delta") &&
		input.hasItem(event.id)
	)
		return;
	const secrets = input.redact();
	await input.onEvent(
		secrets.length ? redactSecretValues(event, secrets) : event,
	);
}

async function readRunState(
	shell: ClaudeCodeShell,
	turnDirectory: string,
): Promise<RunState> {
	const output = await checked(
		shell,
		`d=${quote(turnDirectory)}; n=$(cat "$d/current" 2>/dev/null || true); printf '%s\\n' "$n"; if [ -n "$n" ]; then [ -f "$d/$n/consumed" ] && echo consumed || echo active; cat "$d/session" 2>/dev/null || true; fi`,
		"its state could not be read.",
	);
	const [runText = "", consumedText = "", sessionText = ""] =
		output.split("\n");
	const run = /^\d{1,4}$/.test(runText.trim()) ? Number(runText.trim()) : null;
	return {
		run,
		consumed: consumedText.trim() === "consumed",
		sessionId: isClaudeCodeSessionId(sessionText.trim())
			? sessionText.trim()
			: null,
	};
}

/**
 * Starts run `run` of this turn with the user messages since the last
 * answer, resuming the chat's Claude Code session when its transcript is
 * here or can be restored. Null when there is nothing new to send.
 */
async function launchRun(
	input: ClaudeCodeStepInput,
	home: string,
	turnDirectory: string,
	run: number,
	turnSessionId: string | null,
): Promise<{ run: number } | null> {
	const { shell } = input;
	if (run > 50)
		throw new ClaudeCodeRunFailure("this turn ran Claude Code too many times.");
	await checked(
		shell,
		claudeCodeInstallScript(false),
		"the Claude Code CLI could not be installed on this machine.",
		300_000,
	);
	const resumeId = input.reader
		? turnSessionId
		: (turnSessionId ?? (await restoredSession(input, home)));
	const prompt = claudeCodePrompt(input.messages, Boolean(resumeId));
	if (!prompt.trim()) return null;
	const runDirectory = `${turnDirectory}/${run}`;
	await checked(
		shell,
		`umask 077; mkdir -p ${quote(runDirectory)}`,
		"could not prepare its run directory.",
	);
	const grant = await issueClaudeCodeGrant(input.grantSecret, {
		userId: input.userId,
		sessionId: input.sessionId,
		turnId: input.turnId,
	});
	input.addRedaction?.(grant);
	const inputs = input.reader
		? `${readerScratchDirectory(input.sessionId)}/claude-${input.turnId}-${run}`
		: runDirectory;
	const configDirectory = input.reader
		? `${readerScratchDirectory(input.sessionId)}/.claude-code`
		: `${home}/${CONFIG}`;
	const environment = {
		CLAUDE_CODE_OAUTH_TOKEN: grant,
		ANTHROPIC_BASE_URL: `${input.edgeOrigin}${CLAUDE_CODE_PROXY_PREFIX}`,
		CLAUDE_CONFIG_DIR: configDirectory,
		DISABLE_AUTOUPDATER: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		DISABLE_BUG_COMMAND: "1",
		IS_SANDBOX: "1",
		MCP_TIMEOUT: "30000",
		MCP_TOOL_TIMEOUT: String(PROCESS_SECONDS * 1000),
	};
	await writeThroughShell(
		shell,
		`${runDirectory}/env`,
		`${Object.entries(environment)
			.map(([name, value]) => `${name}=${quote(value)}`)
			.join("\n")}\n`,
	);
	await writeThroughShell(
		shell,
		`${runDirectory}/mcp.json`,
		JSON.stringify({
			mcpServers: {
				[CLAUDE_CODE_MCP_SERVER]: {
					type: "http",
					url: `${input.edgeOrigin}${CLAUDE_CODE_PROXY_PREFIX}/mcp`,
					headers: { Authorization: `Bearer ${grant}` },
				},
			},
		}),
	);
	await writeThroughShell(
		shell,
		`${runDirectory}/system`,
		systemPrompt(input.cwd, input.reader),
	);
	await writeThroughShell(shell, `${runDirectory}/prompt`, prompt);
	const argv = [
		CLAUDE_CODE_BINARY,
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--model",
		input.modelId,
		"--permission-mode",
		"bypassPermissions",
		"--mcp-config",
		`${inputs}/mcp.json`,
		"--strict-mcp-config",
		"--disallowedTools",
		input.reader
			? "AskUserQuestion,Write,Edit,MultiEdit,NotebookEdit"
			: "AskUserQuestion",
		...(resumeId ? ["--resume", resumeId] : []),
	];
	const cli = `cd ${quote(input.cwd)}
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
set -a; . ${quote(`${inputs}/env`)}; set +a
exec ${argv.map(quote).join(" ")} --append-system-prompt "$(cat ${quote(`${inputs}/system`)})" < ${quote(`${inputs}/prompt`)}`;
	let command = cli;
	if (input.reader) {
		await input.prepareReader?.();
		// The reader cannot read the builder's 0600 files: hand it copies.
		const owner = `${READER_LINUX_USER}:${READER_LINUX_USER}`;
		await checked(
			shell,
			[
				`sudo -n install -d -o ${READER_LINUX_USER} -g ${READER_LINUX_USER} -m 0700 ${quote(inputs)} ${quote(configDirectory)}`,
				...["env", "mcp.json", "system", "prompt"].map(
					(name) =>
						`sudo -n install -o ${READER_LINUX_USER} -g ${READER_LINUX_USER} -m 0600 ${quote(`${runDirectory}/${name}`)} ${quote(`${inputs}/${name}`)}`,
				),
				`sudo -n chown ${owner} ${quote(inputs)}`,
			].join(" && "),
			"could not hand its input to the read-only helper.",
		);
		command = readerNetworkedCommand(input.sessionId, cli);
	}
	const scoped = scopedShellCommand({
		turnId: input.turnId,
		cwd: input.cwd,
		command,
		seconds: PROCESS_SECONDS,
		commandId: claudeCodeCommandId(input.turnId, run),
	});
	await checked(
		shell,
		`d=${quote(runDirectory)}; t=${quote(turnDirectory)}; if [ ! -f "$d/started" ]; then setsid nohup bash -c ${quote(`${scoped} >"$1/out" 2>"$1/err" </dev/null; echo $? >"$1/status.tmp"; mv "$1/status.tmp" "$1/status"`)} _ "$d" </dev/null >/dev/null 2>&1 & date +%s >"$d/started"; printf '%s' ${run} >"$t/current.tmp"; mv "$t/current.tmp" "$t/current"; fi`,
		"Claude Code could not be started.",
	);
	return { run };
}

/** The chat's saved session, restored onto this machine when it is not here yet. */
async function restoredSession(
	input: ClaudeCodeStepInput,
	home: string,
): Promise<string | null> {
	const record = await input.store.readSession().catch(() => null);
	if (!record) return null;
	const path = transcriptPath(home, input.cwd, record.claudeSessionId);
	const present = await input.shell(`test -s ${quote(path)}`, 15_000);
	if (present.exitCode === 0) return record.claudeSessionId;
	if (!record.transcriptPath) return null;
	try {
		const text = await input.store.downloadTranscript(record.transcriptPath);
		await checked(
			input.shell,
			`umask 077; mkdir -p ${quote(path.slice(0, path.lastIndexOf("/")))}`,
			"could not restore its session.",
		);
		await input.writeFile(path, text);
		return record.claudeSessionId;
	} catch (error) {
		// The turn starts a new session with the conversation as its context.
		console.warn("Claude Code session could not be restored.", {
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
		return null;
	}
}

function transcriptPath(home: string, cwd: string, claudeSessionId: string) {
	return `${home}/${CONFIG}/projects/${claudeCodeProjectDirectory(cwd)}/${claudeSessionId}.jsonl`;
}

async function saveTranscript(
	input: ClaudeCodeStepInput,
	home: string,
	claudeSessionId: string,
) {
	// A read-only helper's session lives in the reader's scratch for this turn only.
	if (input.reader) return;
	const text = await input.readFile(
		transcriptPath(home, input.cwd, claudeSessionId),
	);
	if (!text) return;
	if (Buffer.byteLength(text) > MAX_TRANSCRIPT_BYTES) {
		await input.store.saveSession({
			claudeSessionId,
			transcriptPath: null,
			cwd: input.cwd,
		});
		return;
	}
	const path = await input.store.uploadTranscript(claudeSessionId, text);
	await input.store.saveSession({
		claudeSessionId,
		transcriptPath: path,
		cwd: input.cwd,
	});
}

async function finishRun(
	shell: ClaudeCodeShell,
	runDirectory: string,
	commit: number,
) {
	await shell(
		`${commit >= 0 ? `printf '%s' ${commit} > ${quote(`${runDirectory}/offset`)}; ` : ""}: > ${quote(`${runDirectory}/consumed`)}; rm -f ${quote(`${runDirectory}/env`)} ${quote(`${runDirectory}/mcp.json`)}; true`,
		15_000,
	).catch(() => undefined);
}

async function completeRun(
	input: ClaudeCodeStepInput,
	result: ClaudeCodeResult,
	home: string,
	apiError: string | null,
): Promise<ClaudeCodeStepResult> {
	if (result.sessionId && isClaudeCodeSessionId(result.sessionId)) {
		await input
			.shell(
				`printf '%s' ${quote(result.sessionId)} > ${quote(`${home}/${RUNS}/${input.turnId}/session`)}`,
				15_000,
			)
			.catch(() => undefined);
	}
	if (!result.ok)
		throw await subscriptionFailure(
			input,
			result.failure === "error" && apiError
				? { ...result, ...claudeCodeFailure(apiError) }
				: result,
		);
	if (result.usage) await input.onEvent({ type: "usage", usage: result.usage });
	await input.onEvent({
		type: "finish",
		inputTokens: result.usage?.inputTokens ?? null,
		outputTokens: result.usage?.outputTokens ?? null,
		reason: "stop",
	});
	const text = result.text.trim();
	const secrets = input.redact();
	return {
		messages: [
			...input.messages,
			{
				role: "assistant",
				content: secrets.length
					? redactSecretValues(text || "Done.", secrets)
					: text || "Done.",
			},
		],
		outcome: "completed",
	};
}

/** A failed result as the failure failover and the chat understand. */
async function subscriptionFailure(
	input: ClaudeCodeStepInput,
	result: Pick<ClaudeCodeResult, "failure" | "resetsAt" | "subtype">,
) {
	const status = await input.store.subscriptionStatus().catch(() => null);
	if (status?.status === "refused" || result.failure === "refused")
		return new ClaudeSubscriptionRefused();
	if (status?.status === "limited" || result.failure === "usage-limit") {
		const resetsAt =
			(status?.status === "limited" ? status.limitedUntil : null) ??
			result.resetsAt ??
			null;
		return new ClaudeSubscriptionLimitReached(
			resetsAt ? new Date(resetsAt) : null,
		);
	}
	if (
		result.failure === "outage" ||
		result.failure === "overloaded" ||
		result.failure === "rate-limited"
	)
		return new ClaudeCodeApiUnavailable(result.failure);
	return new ClaudeCodeRunFailure(
		result.subtype === "error_max_turns"
			? "it reached its turn limit."
			: "it reported an error.",
	);
}

async function exitFailure(
	input: ClaudeCodeStepInput,
	runDirectory: string,
	status: string,
	apiError: string | null,
) {
	const stderr = await input
		.shell(
			`tail -c 2000 ${quote(`${runDirectory}/err`)} 2>/dev/null || true`,
			15_000,
		)
		.then((result) => result.stdout)
		.catch(() => "");
	const fromStderr = claudeCodeFailure(stderr);
	const classified =
		fromStderr.failure === "error" && apiError
			? claudeCodeFailure(apiError)
			: fromStderr;
	if (classified.failure !== "error")
		return subscriptionFailure(input, {
			failure: classified.failure,
			resetsAt: classified.resetsAt,
			subtype: "exit",
		});
	const fromStatus = await subscriptionFailure(input, { subtype: "exit" });
	if (!(fromStatus instanceof ClaudeCodeRunFailure)) return fromStatus;
	return new ClaudeCodeRunFailure(
		status === "124"
			? "it ran past its time limit."
			: `it exited without an answer (code ${/^\d{1,3}$/.test(status) ? status : "unknown"}).`,
	);
}

/** The scoped command id of a turn's Claude Code run, so that run alone can be stopped. */
export function claudeCodeCommandId(turnId: string, run: number) {
	return `cc-${turnId}-${run}`;
}

/**
 * Stops the turn's running Claude Code CLI, if any, and marks its run
 * consumed, so nothing re-attaches to it and its trailing output (often an
 * error after the turn moved to another model) is never read. Best effort:
 * the turn's command scope still stops it when the turn ends.
 */
export async function stopClaudeCodeRun(
	shell: ClaudeCodeShell,
	turnId: string,
): Promise<void> {
	if (!/^[a-f0-9-]{36}$/.test(turnId)) throw new Error("Invalid turn id.");
	const root = commandScopeRoot(turnId);
	await shell(
		`d="$HOME"/${RUNS}/${turnId}; n=$(cat "$d/current" 2>/dev/null || true); case "$n" in ''|*[!0-9]*) exit 0;; esac; python3 -c ${quote(COMMAND_STOP_SCRIPT)} ${quote(root)} "cc-${turnId}-$n"; : > "$d/$n/consumed"; rm -f "$d/$n/env" "$d/$n/mcp.json"; true`,
		20_000,
	);
}
