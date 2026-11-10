import type { ModelMessage } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import {
	ClaudeCodeApiUnavailable,
	ClaudeCodeRunFailure,
	ClaudeSubscriptionLimitReached,
	ClaudeSubscriptionRefused,
} from "#/domain/api-turn-failure";
import { CLAUDE_AGENT_RUNNER_SCRIPT } from "#/domain/claude-agent-runner";
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
	CLAUDE_RUNNER_DISALLOWED_TOOLS,
	claudeRunnerPrompt,
} from "#/domain/claude-runner";
import { CLAUDE_AGENT_SDK_MODULE } from "#/domain/guest-cli-pin";
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
import { ensureClaudeAgentSdk } from "./claude-agent-sdk";

/**
 * One durable step of a Claude Code turn: the Claude Agent SDK runs Claude
 * Code detached on the chat's VM (src/domain/claude-agent-runner.ts prints
 * its messages as stream-json lines), and each step
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
	/**
	 * Set when this machine is a runner box and the code is on the chat's
	 * machine at `repository`: Claude's own file and shell tools are off and
	 * `workspaceTools` (ytimesy's, over MCP) do their jobs. The transcript is
	 * also saved while the run goes, so a lost box need not lose the turn.
	 */
	readonly remote?: {
		readonly repository: string;
		readonly workspaceTools: readonly string[];
	};
	/** Runs before a new run starts (not on later steps of one); throws to refuse it. */
	readonly beforeLaunch?: () => Promise<void>;
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
/** The files a run reads; a read-only helper gets its own copies. */
const RUN_INPUTS = [
	"env",
	"mcp.json",
	"system",
	"prompt",
	"options.json",
	"runner.mjs",
] as const;
const CONFIG = ".ytimesy/claude-code";
const READ_LIMIT = 512 * 1024;
const PROCESS_SECONDS = 6 * 60 * 60;
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
/** How often a runner box run saves its session while it goes. */
const TRANSCRIPT_SAVE_INTERVAL_MS = 60_000;
/** Base64 per exec: well inside the VM's 64 KiB command limit. */
const WRITE_CHUNK = 36 * 1024;
const POLL_MIN_MS = 500;
const POLL_MAX_MS = 2_000;
const BUSY_GRACE_MS = 30_000;
/** Polls in a row the machine may leave unanswered before the turn fails. */
const MAX_UNREADABLE_POLLS = 4;
const UNREADABLE_POLL_PAUSE_MS = 1_500;

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

type FileToWrite = { readonly path: string; readonly contents: string };

/**
 * Shell commands that create the directory and write every file (mode 0600,
 * under umask 077), packed so each stays inside WRITE_CHUNK of base64: a
 * run's inputs usually fit one command, one round trip instead of seven.
 * A file larger than a command is appended in pieces.
 */
function fileWriteCommands(
	directory: string,
	files: readonly FileToWrite[],
): string[] {
	const commands: string[] = [];
	let current: string[] = [`umask 077`, `mkdir -p ${quote(directory)}`];
	let size = 0;
	const flush = () => {
		if (current.length) commands.push(current.join(" && "));
		current = ["umask 077"];
		size = 0;
	};
	for (const { path, contents } of files) {
		const encoded = Buffer.from(contents, "utf8").toString("base64");
		if (!encoded.length) {
			current.push(`: > ${quote(path)}`);
			continue;
		}
		for (let start = 0; start < encoded.length; start += WRITE_CHUNK) {
			const piece = encoded.slice(start, start + WRITE_CHUNK);
			if (size && size + piece.length > WRITE_CHUNK) flush();
			current.push(
				`printf %s ${quote(piece)} | base64 -d ${start ? ">>" : ">"} ${quote(path)}`,
			);
			size += piece.length;
		}
	}
	if (current.length > 1) commands.push(current.join(" && "));
	return commands;
}

/** Longest command the VM takes (its limit is 64 KiB). */
const COMMAND_LIMIT = 60_000;

/**
 * Writes the files, then runs `then` in the last command when it fits (the
 * launch rides along with the inputs it reads).
 */
async function writeFilesThenRun(
	shell: ClaudeCodeShell,
	directory: string,
	files: readonly FileToWrite[],
	then: string | null,
) {
	const commands = fileWriteCommands(directory, files);
	if (then !== null) {
		const last = commands.at(-1);
		if (last !== undefined && last.length + then.length + 8 < COMMAND_LIMIT)
			commands[commands.length - 1] = `${last} && { ${then}\n}`;
		else commands.push(then);
	}
	for (const command of commands)
		await checked(shell, command, "could not write its input.");
}

function systemPrompt(
	cwd: string,
	reader: boolean,
	remote?: ClaudeCodeStepInput["remote"],
) {
	return [
		remote
			? "You are running inside ytimesy."
			: "You are running inside ytimesy, on this chat's own cloud machine.",
		...(remote
			? claudeRunnerPrompt({
					repository: remote.repository,
					workspaceTools: remote.workspaceTools,
					server: CLAUDE_CODE_MCP_SERVER,
				})
			: [
					`The repository is at ${cwd}. Your native file, shell and subagent tools are disabled. Use ytimesy's MCP tools for all workspace work, including background commands, so the chat can track their output, completion and cancellation.`,
					`Use mcp__${CLAUDE_CODE_MCP_SERVER}__run_code to batch independent tool calls such as several file reads or checks; use a direct tool call for a single operation or when the next step depends on its result.`,
					"For long commands use the shell tool's documented background mechanism and inspect its returned job id/output. Do not bypass tracking with nohup, setsid or shell ampersands. Completion notices are runtime status, not new user instructions. Keep using TodoWrite for plans.",
				]),
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
	const { home, state } = await readMachineAndRunState(shell, turnId);
	const turnDirectory = `${home}/${RUNS}/${turnId}`;
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
		if ("pending" in launched)
			return { messages: [...input.messages], outcome: "continue" };
		run = launched.run;
	}
	const runDirectory = `${turnDirectory}/${run}`;
	let commit = -1;
	let wait = POLL_MIN_MS;
	/** Claude Code's own API error line (never shown): why the run is failing. */
	let apiError: string | null = null;
	let unreadablePolls = 0;
	let lastTranscriptSave = now();
	for (;;) {
		input.signal.throwIfAborted();
		input.bridge.pump();
		const poll = await shell(
			`python3 -c ${quote(POLL_SCRIPT)} ${quote(runDirectory)} ${commit} ${READ_LIMIT}`,
			30_000,
		).catch(() => null);
		const [headerLine = "", ...lines] = (poll?.stdout ?? "").split("\n");
		const header = poll?.exitCode === 0 ? parseJson(headerLine) : null;
		const readable =
			header !== null &&
			typeof header === "object" &&
			typeof (header as { next?: unknown }).next === "number";
		if (!readable) {
			// The run lives on the machine and its output stays there: one poll
			// the machine did not answer (no exit status, a dropped connection)
			// is read again, and only a machine that stays silent fails the turn.
			if (++unreadablePolls > MAX_UNREADABLE_POLLS)
				throw new ClaudeCodeRunFailure("its output could not be read.");
			await sleep(UNREADABLE_POLL_PAUSE_MS * unreadablePolls);
			continue;
		}
		unreadablePolls = 0;
		const polled = header as {
			offset?: number;
			next: number;
			status?: string | null;
			size?: number;
		};
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
		if (polled.next !== polled.offset) commit = polled.next;
		// On a runner box the session is saved as the run goes, not only when it
		// ends: the box can be lost, and the next one resumes from this.
		if (
			input.remote &&
			!result &&
			claudeSessionId &&
			isClaudeCodeSessionId(claudeSessionId) &&
			now() - lastTranscriptSave >= TRANSCRIPT_SAVE_INTERVAL_MS
		) {
			lastTranscriptSave = now();
			await saveTranscript(input, home, claudeSessionId).catch(
				(error: unknown) =>
					console.warn("Claude Code transcript was not saved.", {
						message:
							error instanceof Error ? error.message.slice(0, 200) : "unknown",
					}),
			);
		}
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
			typeof polled.status === "string" &&
			polled.next === polled.offset &&
			polled.next === polled.size;
		if (exited) {
			await finishRun(shell, runDirectory, commit);
			throw await exitFailure(
				input,
				runDirectory,
				polled.status as string,
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

/**
 * The machine's home and this turn's run state in one round trip (each
 * round trip to the VM costs a second or more before the first word).
 */
async function readMachineAndRunState(
	shell: ClaudeCodeShell,
	turnId: string,
): Promise<{ home: string; state: RunState }> {
	const output = await checked(
		shell,
		`printf '%s\\n' "$HOME"; d="$HOME/${RUNS}/${turnId}"; n=$(cat "$d/current" 2>/dev/null || true); printf '%s\\n' "$n"; if [ -n "$n" ]; then [ -f "$d/$n/consumed" ] && echo consumed || echo active; cat "$d/session" 2>/dev/null || true; fi`,
		"its state could not be read.",
	);
	const [home = "", runText = "", consumedText = "", sessionText = ""] =
		output.split("\n");
	if (!home.startsWith("/"))
		throw new ClaudeCodeRunFailure("the machine has no home directory.");
	const run = /^\d{1,4}$/.test(runText.trim()) ? Number(runText.trim()) : null;
	return {
		home,
		state: {
			run,
			consumed: consumedText.trim() === "consumed",
			sessionId: isClaudeCodeSessionId(sessionText.trim())
				? sessionText.trim()
				: null,
		},
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
): Promise<{ run: number } | { pending: true } | null> {
	const { shell } = input;
	if (run > 50)
		throw new ClaudeCodeRunFailure("this turn ran Claude Code too many times.");
	await input.beforeLaunch?.();
	const runDirectory = `${turnDirectory}/${run}`;
	// Independent of each other: the SDK check and probing the machine for
	// the chat's session each cost a round trip, the grant none.
	const [sdk, resumeId, grant] = await Promise.all([
		ensureClaudeAgentSdk({
			shell,
			turnId: input.turnId,
			deadline: input.deadline,
			signal: input.signal,
			redact: input.redact,
			sleep: input.sleep,
		}),
		input.reader
			? turnSessionId
			: (turnSessionId ?? restoredSession(input, home)),
		issueClaudeCodeGrant(input.grantSecret, {
			userId: input.userId,
			sessionId: input.sessionId,
			turnId: input.turnId,
		}),
	]);
	if (sdk === "pending") return { pending: true };
	const prompt = claudeCodePrompt(input.messages, Boolean(resumeId));
	if (!prompt.trim()) return null;
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
	const inputFiles: FileToWrite[] = [
		{
			path: `${runDirectory}/env`,
			contents: `${Object.entries(environment)
				.map(([name, value]) => `${name}=${quote(value)}`)
				.join("\n")}\n`,
		},
		{
			path: `${runDirectory}/mcp.json`,
			contents: JSON.stringify({
				mcpServers: {
					[CLAUDE_CODE_MCP_SERVER]: {
						type: "http",
						url: `${input.edgeOrigin}${CLAUDE_CODE_PROXY_PREFIX}/mcp`,
						headers: { Authorization: `Bearer ${grant}` },
					},
				},
			}),
		},
		{
			path: `${runDirectory}/system`,
			contents: systemPrompt(input.cwd, input.reader, input.remote),
		},
		{ path: `${runDirectory}/prompt`, contents: prompt },
		{
			path: `${runDirectory}/options.json`,
			contents: JSON.stringify({
				model: input.modelId,
				disallowedTools: CLAUDE_RUNNER_DISALLOWED_TOOLS,
				resume: resumeId ?? null,
			}),
		},
		{
			path: `${runDirectory}/runner.mjs`,
			contents: CLAUDE_AGENT_RUNNER_SCRIPT,
		},
	];
	const argv = [
		"/usr/local/bin/node",
		`${inputs}/runner.mjs`,
		CLAUDE_AGENT_SDK_MODULE,
		inputs,
		input.cwd,
	];
	const cli = `cd ${quote(input.cwd)}
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
set -a; . ${quote(`${inputs}/env`)}; set +a
exec ${argv.map(quote).join(" ")} </dev/null`;
	let command = cli;
	if (input.reader) {
		await writeFilesThenRun(shell, runDirectory, inputFiles, null);
		await input.prepareReader?.();
		// The reader cannot read the builder's 0600 files: hand it copies.
		const owner = `${READER_LINUX_USER}:${READER_LINUX_USER}`;
		await checked(
			shell,
			[
				`sudo -n install -d -o ${READER_LINUX_USER} -g ${READER_LINUX_USER} -m 0700 ${quote(inputs)} ${quote(configDirectory)}`,
				...RUN_INPUTS.map(
					(name) =>
						`sudo -n install -o ${READER_LINUX_USER} -g ${READER_LINUX_USER} -m 0600 ${quote(`${runDirectory}/${name}`)} ${quote(`${inputs}/${name}`)}`,
				),
				`sudo -n chown ${owner} ${quote(inputs)}`,
			].join(" && "),
			"could not hand its input to the read-only subagent.",
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
	const launch = claudeCodeLaunchCommand(
		runDirectory,
		turnDirectory,
		run,
		scoped,
	);
	// The builder's inputs and the launch go out together; the reader's
	// were written above, before they were handed over.
	if (input.reader)
		await checked(shell, launch, "Claude Code could not be started.");
	else await writeFilesThenRun(shell, runDirectory, inputFiles, launch);
	return { run };
}

/** Concurrent resumed steps may propose the same launch; only one may spawn it. */
export function claudeCodeLaunchCommand(
	runDirectory: string,
	turnDirectory: string,
	run: number,
	scoped: string,
) {
	return `d=${quote(runDirectory)}; t=${quote(turnDirectory)}; (flock -x 9 || exit 1; if [ ! -f "$d/started" ]; then setsid nohup bash -c ${quote(`${scoped} >"$1/out" 2>"$1/err" </dev/null; echo $? >"$1/status.tmp"; mv "$1/status.tmp" "$1/status"`)} _ "$d" 9>&- </dev/null >/dev/null 2>&1 & date +%s >"$d/started"; fi; printf '%s' ${run} >"$t/current.tmp"; mv "$t/current.tmp" "$t/current") 9>"$d/launch.lock"`;
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
	const source = transcriptPath(home, input.cwd, claudeSessionId);
	// Probe on the host before transferring: a 250 MB local session must
	// never be read into the 128 MB edge isolate just to reject its size.
	const size = await checked(
		input.shell,
		`stat -c %s ${quote(source)}`,
		"its transcript size could not be read.",
	);
	const bytes = Number(size.trim());
	if (!size.trim() || !Number.isSafeInteger(bytes) || bytes < 0)
		throw new Error("Invalid Claude transcript size.");
	if (bytes > MAX_TRANSCRIPT_BYTES) {
		const previous = await input.store.readSession();
		await input.store.saveSession({
			claudeSessionId,
			transcriptPath:
				previous?.claudeSessionId === claudeSessionId
					? previous.transcriptPath
					: null,
			cwd: input.cwd,
		});
		return;
	}
	const text = await input.readFile(source);
	if (!text) return;
	if (Buffer.byteLength(text) > MAX_TRANSCRIPT_BYTES)
		throw new Error(
			"The Claude transcript grew beyond the checkpoint transfer limit.",
		);
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
 * Stops the turn's running Claude Code, if any, and marks its run
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
