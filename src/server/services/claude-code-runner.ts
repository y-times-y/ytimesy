import type { ModelMessage } from "ai";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import {
	ClaudeCodeApiUnavailable,
	ClaudeCodeRunFailure,
	ClaudeCodeRunInterrupted,
	ClaudeRunnerTransportFailure,
	ClaudeSubscriptionLimitReached,
	ClaudeSubscriptionRefused,
} from "#/domain/api-turn-failure";
import { artifactInstructions } from "#/domain/artifact";
import { CANVAS_TOOL, canvasInstructions } from "#/domain/canvas";
import { CLAUDE_AGENT_RUNNER_SCRIPT } from "#/domain/claude-agent-runner";
import {
	CLAUDE_BOX_TOOLS_ACTIVE,
	CLAUDE_BOX_TOOLS_CONFIG,
} from "#/domain/claude-box-tools";
import { issueClaudeCodeGrant } from "#/domain/claude-code-grant";
import { CLAUDE_CODE_PROXY_PREFIX } from "#/domain/claude-code-proxy";
import {
	CLAUDE_CODE_MCP_PREFIX,
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
	CLAUDE_CODE_FEED_PATH,
	type ClaudeFeedState,
	claudeStepSource,
} from "#/domain/claude-feed";
import {
	CLAUDE_RUNNER_DISALLOWED_TOOLS,
	CLAUDE_RUNNER_Y_SQUARED_DISALLOWED_TOOLS,
	claudeRunnerPrompt,
	claudeWorkspaceCommandsPrompt,
} from "#/domain/claude-runner";
import {
	type DirectTranscriptStore,
	directDownloadCommand,
	directUploadCommand,
	isDirectTranscriptPath,
	MAX_DIRECT_TRANSCRIPT_BYTES,
} from "#/domain/direct-transcript";
import { CLAUDE_AGENT_SDK_MODULE } from "#/domain/guest-cli-pin";
import type { LeanToolShape } from "#/domain/harness-model-profile";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { redactSecretValues } from "#/domain/project-secret";
import {
	PULL_REQUEST_INSTRUCTIONS,
	PULL_REQUEST_REMINDER,
} from "#/domain/pull-request-tools";
import {
	READER_LINUX_USER,
	readerNetworkedCommand,
	readerScratchDirectory,
} from "#/domain/subagent-reader";
import { Y_SQUARED_TOOLS } from "#/domain/y-squared";
import type {
	ClaudeCodeSessionRecord,
	ClaudeSubscriptionStatus,
} from "../adapters/claude-subscription";
import { isPlatformRestart } from "../adapters/freestyle/provider-retry";
import type { ClaudeBoxToolsConfig } from "../claude-box-tools/server";
import {
	COMMAND_SCOPES_DIRECTORY,
	COMMAND_STOP_SCRIPT,
	commandScopeRoot,
	scopedShellCommand,
} from "./api-command-scope";
import { ensureClaudeAgentSdk } from "./claude-agent-sdk";
import type { ClaudeBoxToolGrant } from "./claude-box-tool-grant";
import {
	CLAUDE_STEP_MIN_AWAKE_MS,
	CLAUDE_STEP_PAUSE_MS,
} from "./claude-step-pause";

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
	/**
	 * Sends a transcript above the inline limit from the VM straight to R2,
	 * encrypted there with a one-time key, so the Durable Object never holds it.
	 * Absent where private R2 storage is not configured.
	 */
	readonly direct?: DirectTranscriptStore;
	readonly subscriptionStatus: () => Promise<ClaudeSubscriptionStatus>;
};

/**
 * The run's output as the chat's object received it from the runner
 * (claude-feed.ts); present only where the feed is on and the step runs in
 * that object.
 */
export type ClaudeCodeFeed = {
	readonly state: (run: number) => ClaudeFeedState | null;
	readonly lines: (
		run: number,
		from: number,
		limit: number,
	) => readonly { offset: number; next: number; line: string }[];
	/** The step read the run through `to`; kept once its checkpoint commits. */
	readonly consume: (run: number, to: number) => void;
	/** Resolves when lines (or the exit) arrive, or after `ms`. */
	readonly wait: (ms: number) => Promise<void>;
};

export type ClaudeCodeStepInput = {
	/** The run's pushed output; without it (or its runner's hello) the step polls. */
	readonly feed?: ClaudeCodeFeed;
	/**
	 * Whether this step may end early so the chat's object sleeps while
	 * Claude works on its own (claude-step-pause.ts); absent: never.
	 */
	readonly mayPause?: () => boolean;
	/**
	 * The same for a step following the run's feed, which may end whether or
	 * not someone watches (the object previews the text meanwhile); absent:
	 * `mayPause` decides.
	 */
	readonly mayPauseOnFeed?: () => boolean;
	/** The step ended early: its next one should start after `ms`. */
	readonly requestPause?: (ms: number) => void;
	/**
	 * A feed step ended with nothing to do: the turn parks until the feed or
	 * a call wakes it (claude-parked-turn.ts); absent: `requestPause`.
	 */
	readonly requestPark?: () => void;
	/** Runs a command on the VM as its default (builder) user. */
	readonly shell: ClaudeCodeShell;
	/** Writes and reads a file as the default user (transcript restore and save). */
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	readonly readFile: (path: string) => Promise<string | null>;
	readonly cwd: string;
	readonly userId: string;
	/** The pull request the platform opened for this chat, told each run. */
	readonly pullRequestNote?: string;
	readonly sessionId: string;
	readonly turnId: string;
	/** Claude Code's --model. */
	readonly modelId: string;
	/** Claude Code's effort (low to max); the model's own default when absent. */
	readonly effort?: string;
	readonly messages: readonly ModelMessage[];
	/** The edge's public origin (the git proxy's), which the VM reaches. */
	readonly edgeOrigin: string;
	/** Signs the run's grant here; or `issueGrant` mints it elsewhere (a turn box asks the edge). */
	readonly grantSecret?: string;
	readonly issueGrant?: () => Promise<string>;
	/**
	 * A poll may wait on the machine up to this long for new output (a turn
	 * box, whose every poll is a request through the edge); 0: answers at once.
	 */
	readonly pollWaitMs?: number;
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
	/**
	 * Y²: the run has no machine and no repository, and only ytimesy's tools
	 * (docs/claude-code-placement.md). Needs `remote`. `instructions` replace
	 * the repository, run_code, browser, job and canvas lines of the system
	 * prompt, and every native Claude tool is off.
	 */
	/** The compact secret-names line (secretsContextLine); the system prompt carries it every step. */
	readonly secretsLine?: string;
	/** The delegation rules (orchestration block) for the system prompt; absent without the agent tool. */
	readonly delegation?: string;
	readonly ySquared?: {
		readonly instructions: string;
		/** The names of the tools the run is offered (the real set, not a hand list). */
		readonly tools?: readonly string[];
	};
	/**
	 * With `remote`: the run serves these lean workspace tools on its runner
	 * box, straight against the chat's VM (claude-box-tools/), instead of
	 * through this object. Each new run gets its own grant; without one
	 * (null) it uses the edge's tools as before.
	 */
	readonly boxTools?: {
		readonly tools: readonly string[];
		readonly shape: LeanToolShape;
		/** Turn tokens the edge put on the VM, which results must not show. */
		readonly redact: () => readonly string[];
		readonly grant: () => Promise<ClaudeBoxToolGrant | null>;
		/** The bundled tool server (scripts/build-claude-box-tools.ts) and its version. */
		readonly bundle: () => { source: string; version: string };
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
/**
 * The largest transcript the chat's Durable Object backs up itself. Reading it,
 * wrapping, sealing and signing it holds about five live copies in a 128 MB
 * isolate shared with other chats, so a larger file is left on the VM (the
 * previous backup stays) rather than risk a platform reset that fails a turn
 * that has already answered. Production logs showed 15 MB saves doing this.
 */
const INLINE_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
/** How often a runner box run saves its session while it goes. */
const TRANSCRIPT_SAVE_INTERVAL_MS = 60_000;
/**
 * When each turn's transcript was last saved, across its steps: a step that
 * pauses after a few seconds would otherwise never reach the interval.
 */
const lastTranscriptSaves = new Map<string, number>();
/** Base64 per exec: well inside the VM's 64 KiB command limit. */
const WRITE_CHUNK = 36 * 1024;
const POLL_MIN_MS = 500;
const POLL_MAX_MS = 2_000;
/** The least time between a waiting poll's start and the next one's. */
const WAITING_POLL_SPACING_MS = 1_000;

function requiredGrantSecret(secret: string | undefined) {
	if (!secret) throw new Error("The run's grant cannot be signed here.");
	return secret;
}
const BUSY_GRACE_MS = 30_000;
/** A poll needs at least this long to be worth sending (else the step yields). */
const MIN_POLL_BUDGET_MS = 3_000;
/** Polls in a row the machine may leave unanswered before the turn fails. */
const MAX_UNREADABLE_POLLS = 4;
const UNREADABLE_POLL_PAUSE_MS = 1_500;

/**
 * Reports a run's state and the complete lines since its saved offset,
 * after saving the offset the runner finished (argv: run dir, offset to
 * save or -1, byte limit). The saved offset only moves forward: a step
 * that starts from an older position (a feed step's) never moves it back.
 * Header line: {"offset","next","status","size"};
 * then one "<byte offset>\t<line>" per line. A line longer than the limit
 * is skipped and reported as {"type":"ytimesy_oversize"}.
 */
export const CLAUDE_CODE_POLL_SCRIPT = `import json,os,sys,time
d,commit,limit=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
wait=float(sys.argv[4]) if len(sys.argv)>4 else 0
try: off=int(open(os.path.join(d,'offset')).read().strip() or 0)
except FileNotFoundError: off=0
if commit>off:
    t=os.path.join(d,'offset.tmp'); open(t,'w').write(str(commit)); os.replace(t,os.path.join(d,'offset')); off=commit
until=time.time()+min(wait,25)
while limit>0 and time.time()<until and not os.path.exists(os.path.join(d,'status')):
    try:
        with open(os.path.join(d,'out'),'rb') as f:
            f.seek(off)
            if b'\\n' in f.read(1<<16): break
    except FileNotFoundError: pass
    time.sleep(0.2)
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
process=None
if status is None and os.path.isdir('/proc/self'):
    try:
        started=os.path.join(d,'started')
        if time.time()-os.path.getmtime(started)>=30:
            turn=os.path.basename(os.path.dirname(d)); run=os.path.basename(d)
            record=os.path.join('${COMMAND_SCOPES_DIRECTORY}',turn,'cc-'+turn+'-'+run+'.json')
            try:
                saved=json.load(open(record)); pid=int(saved['pid'])
                fields=open('/proc/'+str(pid)+'/stat').read().rsplit(')',1)[1].split()
                process='alive' if pid>1 and os.getpgid(pid)==pid and fields[19]==saved['start'] and fields[0]!='Z' else 'missing'
            except (FileNotFoundError,ProcessLookupError): process='missing'
    except FileNotFoundError: pass
print(json.dumps({'offset':off,'next':nxt,'status':status,'size':size,'process':process}))
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

/** "a, b and c" over the offered tool names (Y_SQUARED_TOOLS when the step names none). */
export function ySquaredToolList(names?: readonly string[]): string {
	const list = names?.length ? names : [...Y_SQUARED_TOOLS];
	return list.length > 1
		? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`
		: (list[0] ?? "");
}

/** The CLI's system prompt; written afresh on every step, so a resumed session and a compacted one carry it. */
export function systemPrompt(
	cwd: string,
	reader: boolean,
	remote?: ClaudeCodeStepInput["remote"],
	ySquared?: ClaudeCodeStepInput["ySquared"],
	pullRequest?: string,
	secretsLine?: string,
	delegation?: string,
) {
	if (ySquared)
		return [
			"You are running inside ytimesy.",
			ySquared.instructions,
			`Your tools are ytimesy's, offered as mcp__${CLAUDE_CODE_MCP_SERVER}__*: ${ySquaredToolList(ySquared.tools)}. You have no repository, shell, files or web of your own: your built-in tools are off. When these instructions name a tool, call its mcp__${CLAUDE_CODE_MCP_SERVER}__ form.`,
		].join("\n");
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
					`For long commands use the shell tool's documented background mechanism and inspect its returned job id/output. Do not bypass tracking with nohup, setsid or shell ampersands. Completion notices are runtime status, not new user instructions. When mcp__${CLAUDE_CODE_MCP_SERVER}__update_plan is offered, keep a checklist for multi-step work with it; the chat shows it to the user.`,
				]),
		`ytimesy adds tools as mcp__${CLAUDE_CODE_MCP_SERVER}__*: "agent" starts a helper agent (a writer gets its own machine; read-only helpers share this one) and its report comes back to you; "request_project_secret" asks the user for a secret; "ask_user" asks the user a question (end your turn after asking). Tools these instructions name without the prefix are offered the same way.`,
		reader ? "" : PULL_REQUEST_INSTRUCTIONS,
		reader ? "" : (pullRequest ?? ""),
		delegation ?? "",
		reader
			? ""
			: canvasInstructions(`mcp__${CLAUDE_CODE_MCP_SERVER}__${CANVAS_TOOL}`),
		reader ? "" : artifactInstructions(),
		...claudeWorkspaceCommandsPrompt({ reader }),
		reader
			? "You are a read-only helper: do not change files; report what you find."
			: "",
		reader ? "" : (secretsLine ?? ""),
	]
		.filter(Boolean)
		.join("\n");
}

/** What one step did, logged when it ends to compare feed and poll steps. */
type StepMeasure = { source: "feed" | "poll"; lines: number };

export async function runClaudeCodeStep(
	input: ClaudeCodeStepInput,
): Promise<ClaudeCodeStepResult> {
	const now = input.now ?? Date.now;
	if (!/^[a-f0-9-]{36}$/.test(input.turnId))
		throw new Error("Invalid turn id.");
	const measure: StepMeasure = { source: "poll", lines: 0 };
	const startedAt = now();
	try {
		return await claudeCodeStep(input, measure);
	} finally {
		// One line per step where the feed is on: how long the chat's object
		// was kept awake for it, to compare feed and poll steps.
		if (input.feed)
			console.info(
				JSON.stringify({
					event: "claude.step_end",
					turnId: input.turnId,
					source: measure.source,
					awakeMs: Math.max(0, now() - startedAt),
					linesConsumed: measure.lines,
				}),
			);
	}
}

async function claudeCodeStep(
	input: ClaudeCodeStepInput,
	measure: StepMeasure,
): Promise<ClaudeCodeStepResult> {
	const now = input.now ?? Date.now;
	const sleep = input.sleep ?? input.bridge.wait;
	const { shell, turnId } = input;
	input.signal.throwIfAborted();
	let machineState: Awaited<ReturnType<typeof readMachineAndRunState>> | null =
		null;
	// Only this explicit observation is replayable, never an arbitrary exec.
	for (let attempt = 0; machineState === null; attempt++) {
		input.signal.throwIfAborted();
		try {
			machineState = await readMachineAndRunState(
				shell,
				turnId,
				Math.max(1, Math.min(30_000, input.deadline - now() - 10_000)),
			);
		} catch (error) {
			if (
				!input.remote ||
				!(error instanceof ClaudeRunnerTransportFailure) ||
				!error.retryable
			)
				throw error;
			input.signal.throwIfAborted();
			const pause = UNREADABLE_POLL_PAUSE_MS * (attempt + 1);
			if (
				attempt >= MAX_UNREADABLE_POLLS ||
				now() + pause + 10_000 >= input.deadline
			)
				return { messages: [...input.messages], outcome: "continue" };
			await sleep(pause);
		}
	}
	const { home, state } = machineState;
	const turnDirectory = `${home}/${RUNS}/${turnId}`;
	let run = state.run;
	const claudeSessionId = state.sessionId;
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
	const reader = new ClaudeLineReader(
		input,
		claudeSessionId,
		measure,
		input.boxTools
			? () => boxToolsOfRun(input, `${input.turnId}:${run}`, runDirectory)
			: null,
	);
	const backups = new TranscriptBackups(input, home, now);
	/** The run reported its result: save its session, then the turn's answer. */
	const finishResult = async (result: ClaudeCodeResult, commit: number) => {
		await backups.settled();
		await finishRun(shell, runDirectory, commit);
		const sessionId = result.sessionId ?? reader.sessionId;
		if (sessionId && isClaudeCodeSessionId(sessionId))
			await saveTranscript(input, home, sessionId).catch((error: unknown) =>
				console.warn("Claude Code transcript was not saved.", {
					message:
						error instanceof Error ? error.message.slice(0, 200) : "unknown",
				}),
			);
		return completeRun(
			input,
			result,
			home,
			reader.apiError,
			reader.contextTokens,
		);
	};
	/** The run exited without a result: why, as the turn's failure. */
	const exitedFailure = async (status: string, commit: number) => {
		await backups.settled();
		await finishRun(shell, runDirectory, commit);
		return exitFailure(input, runDirectory, status, reader.apiError);
	};
	// The run's runner pushes its lines to the chat's object: read them there
	// instead of polling the machine (claude-feed.ts).
	if (input.feed && claudeStepSource(input.feed.state(run), now()) === "feed") {
		measure.source = "feed";
		return followFeed({
			input,
			feed: input.feed,
			run,
			reader,
			backups,
			finishResult,
			exitedFailure,
			now,
		});
	}
	// Where a feed step left off (it does not write the machine's offset; the
	// poll never moves that offset back when the machine is further along).
	const fed = input.feed?.state(run)?.consumedTo ?? 0;
	/** How far this step has read the run's output (-1: nothing known yet). */
	let readTo = fed > 0 ? fed : -1;
	/** The offset the next poll saves on the machine (-1: nothing new). */
	let commit = readTo;
	let wait = POLL_MIN_MS;
	let unreadablePolls = 0;
	let missingProcessPolls = 0;
	const stepStartedAt = now();
	/** This step read the run's output at least once (it made progress). */
	let readOnce = false;
	/** Saves where this step read to, on the machine and for a later feed step. */
	const saveOffset = async (timeoutMs: number) => {
		if (readTo < 0) return;
		input.feed?.consume(run, readTo);
		await shell(
			`python3 -c ${quote(CLAUDE_CODE_POLL_SCRIPT)} ${quote(runDirectory)} ${readTo} 0`,
			timeoutMs,
		).catch(() => undefined);
	};
	/** Ends the step for the next one to re-attach, keeping what it has read. */
	const yieldStep = async (): Promise<ClaudeCodeStepResult> => {
		await saveOffset(10_000);
		await backups.settled();
		return { messages: [...input.messages], outcome: "continue" };
	};
	for (;;) {
		input.signal.throwIfAborted();
		input.bridge.pump();
		// The run's feed started (its runner said hello): the next step follows it.
		if (
			input.feed &&
			readOnce &&
			!input.bridge.busy() &&
			claudeStepSource(input.feed.state(run), now()) === "feed"
		)
			return yieldStep();
		let transportFailure: ClaudeRunnerTransportFailure | null = null;
		// The runner HTTP adapter reserves another 10 seconds for the exec reply.
		const pollBudget = Math.min(30_000, input.deadline - now() - 10_000);
		// Too close to the step's end for a poll to answer: the step yields
		// (the run keeps going on its host and the next step re-attaches). A
		// poll given a few milliseconds always "failed", and near the deadline
		// that failure ended the whole turn with "its output could not be
		// read": every run longer than one step (Nov 14 helpers, ~13 min in).
		if (pollBudget < MIN_POLL_BUDGET_MS && readOnce) {
			if (input.bridge.busy() && now() < input.deadline + BUSY_GRACE_MS) {
				await sleep(POLL_MIN_MS);
				continue;
			}
			return yieldStep();
		}
		const pollStartedAt = now();
		// A waiting poll returns at the first new line, the exit or its wait.
		const pollWaitS = input.pollWaitMs
			? Math.max(0, Math.min(input.pollWaitMs, pollBudget - 5_000)) / 1000
			: 0;
		const poll = await shell(
			`python3 -c ${quote(CLAUDE_CODE_POLL_SCRIPT)} ${quote(runDirectory)} ${commit} ${READ_LIMIT}${pollWaitS > 0 ? ` ${pollWaitS.toFixed(1)}` : ""}`,
			Math.max(MIN_POLL_BUDGET_MS, pollBudget),
		).catch((error: unknown) => {
			// A deploy or isolate reset cut this object's own request: the step
			// is interrupted (and resumes on the new code, re-attaching to the
			// run), not the run. Counted as unreadable, such polls failed whole
			// turns with "its output could not be read" (Nov 14, within two
			// minutes of each deploy).
			if (isPlatformRestart(error)) throw error;
			if (error instanceof ClaudeRunnerTransportFailure) {
				transportFailure = new ClaudeRunnerTransportFailure(
					"poll",
					error.reason,
					error.httpStatus,
				);
				if (!error.retryable) throw transportFailure;
			}
			return null;
		});
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
			// Out of step time (not out of patience): yield, never fail. The run
			// and its output stay on the host for the next step to read.
			if (
				now() + UNREADABLE_POLL_PAUSE_MS * (unreadablePolls + 1) + 10_000 >=
				input.deadline
			) {
				input.signal.throwIfAborted();
				// A machine-hosted run's transport loss keeps its own handling.
				if (transportFailure && !input.remote) throw transportFailure;
				return yieldStep();
			}
			if (++unreadablePolls > MAX_UNREADABLE_POLLS) {
				// A remote process owns the run and its tools independently of this
				// step. Reattach next step; never turn transport loss into a launch.
				input.signal.throwIfAborted();
				if (input.remote && transportFailure) {
					return { messages: [...input.messages], outcome: "continue" };
				}
				throw (
					transportFailure ??
					new ClaudeCodeRunFailure("its output could not be read.")
				);
			}
			await sleep(UNREADABLE_POLL_PAUSE_MS * unreadablePolls);
			continue;
		}
		unreadablePolls = 0;
		readOnce = true;
		const polled = header as {
			offset?: number;
			next: number;
			status?: string | null;
			size?: number;
			process?: "alive" | "missing" | null;
		};
		commit = -1;
		let result: ClaudeCodeResult | null = null;
		for (const entry of lines) {
			if (!entry) continue;
			const tab = entry.indexOf("\t");
			if (tab <= 0) continue;
			const read = await reader.read(entry.slice(tab + 1), entry.slice(0, tab));
			if (read) result = read;
		}
		if (polled.next !== polled.offset) commit = polled.next;
		// Everything before `next` is read, by this poll or (the machine's saved
		// offset) an earlier one: an empty poll still counts it.
		readTo = Math.max(readTo, polled.next);
		if (result) {
			input.feed?.consume(run, readTo);
			return finishResult(result, readTo);
		}
		// On a runner box the session is saved as the run goes, not only when it
		// ends: the box can be lost, and the next one resumes from this.
		backups.maybeStart(reader.sessionId);
		const exited =
			typeof polled.status === "string" &&
			polled.next === polled.offset &&
			polled.next === polled.size;
		if (exited) throw await exitedFailure(polled.status as string, readTo);
		// The detached wrapper may be publishing status just after its scoped
		// process exits. Require a second observation before calling it lost.
		missingProcessPolls =
			polled.process === "missing" ? missingProcessPolls + 1 : 0;
		if (missingProcessPolls >= 2) throw new ClaudeCodeRunInterrupted();
		// Yield at the deadline, never with a ytimesy tool call still answering.
		const due = now() + wait >= input.deadline;
		// A tool call still answering holds the step a little past its
		// deadline; it never holds it past the executor's own budget.
		if (
			due &&
			(!input.bridge.busy() || now() >= input.deadline + BUSY_GRACE_MS)
		) {
			await saveOffset(30_000);
			// Nothing of this step may outlive it in the chat's object.
			await backups.settled();
			return { messages: [...input.messages], outcome: "continue" };
		}
		// Nothing to answer and nobody watching: the step ends and the chat's
		// object sleeps until the next one (or a tool call wakes it). Never
		// with a call in flight or a transcript backup due or running.
		if (
			readOnce &&
			!input.bridge.busy() &&
			backups.idle() &&
			now() - stepStartedAt >= CLAUDE_STEP_MIN_AWAKE_MS &&
			input.mayPause?.()
		) {
			input.requestPause?.(CLAUDE_STEP_PAUSE_MS);
			return yieldStep();
		}
		if (input.pollWaitMs) {
			// The poll itself waited for output: while the run streams, at
			// most one poll a second; a quiet one asks again at once.
			if (lines.some(Boolean))
				await sleep(
					Math.max(0, WAITING_POLL_SPACING_MS - (now() - pollStartedAt)),
				);
		} else if (lines.some(Boolean)) wait = POLL_MIN_MS;
		else {
			await sleep(wait);
			wait = Math.min(POLL_MAX_MS, wait * 2);
		}
	}
}

/** How many stored lines a feed step reads at a time. */
const FEED_READ_LINES = 200;
/** A feed step with nothing to read looks again after this, or on a line or call. */
const FEED_IDLE_WAIT_MS = 1_000;

/**
 * The step reading the run's feed: lines from the chat's own storage, in
 * offset order from where the last committed step stopped, through the same
 * mapping as a poll. It ends as soon as it has read what is stored and no
 * ytimesy tool call is in flight, whether or not someone watches: the
 * object previews the run's text to viewers itself and wakes the next step
 * for a tool call, the result or the exit at once, for other lines once
 * they have waited (claude-feed.ts), and after the pause, which renews the
 * turn's lease. The read position is saved once the step's checkpoint
 * commits, so an interrupted step reads those lines again, as a restarted
 * poll does.
 */
async function followFeed(ctx: {
	readonly input: ClaudeCodeStepInput;
	readonly feed: ClaudeCodeFeed;
	readonly run: number;
	readonly reader: ClaudeLineReader;
	readonly backups: TranscriptBackups;
	readonly finishResult: (
		result: ClaudeCodeResult,
		commit: number,
	) => Promise<ClaudeCodeStepResult>;
	readonly exitedFailure: (status: string, commit: number) => Promise<Error>;
	readonly now: () => number;
}): Promise<ClaudeCodeStepResult> {
	const { input, feed, run, reader, backups, now } = ctx;
	let cursor = feed.state(run)?.consumedTo ?? 0;
	const yieldStep = async (park = false): Promise<ClaudeCodeStepResult> => {
		feed.consume(run, cursor);
		if (park && input.requestPark) input.requestPark();
		else if (park) input.requestPause?.(CLAUDE_STEP_PAUSE_MS);
		await backups.settled();
		return { messages: [...input.messages], outcome: "continue" };
	};
	for (;;) {
		input.signal.throwIfAborted();
		input.bridge.pump();
		const state = feed.state(run);
		const busy = input.bridge.busy();
		// The runner went silent (a lost socket, a killed process): the next
		// step polls the machine, which also tells a lost process apart.
		if (!busy && claudeStepSource(state, now()) !== "feed") return yieldStep();
		const lines = feed.lines(run, cursor, FEED_READ_LINES);
		let result: ClaudeCodeResult | null = null;
		for (const entry of lines) {
			const read = await reader.read(entry.line, String(entry.offset));
			cursor = entry.next;
			if (read) result = read;
		}
		if (result) {
			feed.consume(run, cursor);
			return ctx.finishResult(result, cursor);
		}
		if (
			state?.exitStatus != null &&
			!lines.length &&
			cursor >= state.receivedTo
		)
			throw await ctx.exitedFailure(state.exitStatus, cursor);
		backups.maybeStart(reader.sessionId);
		if (
			now() >= input.deadline &&
			(!busy || now() >= input.deadline + BUSY_GRACE_MS)
		)
			return yieldStep();
		if (lines.length) continue;
		// Nothing to read or answer: the object sleeps, watched or not.
		if (!busy && backups.idle() && (input.mayPauseOnFeed ?? input.mayPause)?.())
			return yieldStep(true);
		await Promise.race([
			feed.wait(FEED_IDLE_WAIT_MS),
			input.bridge.wait(FEED_IDLE_WAIT_MS),
		]);
	}
}

/** Maps a run's output lines into the turn, keeping what later lines need. */
class ClaudeLineReader {
	/** Claude Code's own API error line (never shown): why the run is failing. */
	apiError: string | null = null;
	/**
	 * What the latest model call put in the context window; with the window
	 * Claude Code reports at the end, it is the composer's context ring.
	 */
	contextTokens: number | null = null;
	constructor(
		private readonly input: ClaudeCodeStepInput,
		public sessionId: string | null,
		private readonly measure: StepMeasure,
		/** The tools this run served on its box, when box tools are on. */
		private readonly boxTools: (() => Promise<ReadonlySet<string>>) | null,
	) {}
	/** One line; its result, if it is the run's last. */
	async read(line: string, key: string): Promise<ClaudeCodeResult | null> {
		this.measure.lines++;
		let result: ClaudeCodeResult | null = null;
		const boxTools =
			this.boxTools && line.includes(CLAUDE_CODE_MCP_PREFIX)
				? await this.boxTools().catch(() => undefined)
				: undefined;
		for (const effect of claudeCodeEffects(line, key, {
			toolName: this.input.toolName,
			...(boxTools ? { boxTools } : {}),
		})) {
			if (effect.kind === "session") {
				this.sessionId = effect.sessionId;
				if (effect.failedMcpServers.includes(CLAUDE_CODE_MCP_SERVER))
					console.warn("Claude Code could not connect to ytimesy's tools.");
			} else if (effect.kind === "plan") this.input.onPlan(effect.plan);
			else if (effect.kind === "api-error") this.apiError = effect.text;
			else if (effect.kind === "result") result = effect.result;
			else if (effect.kind === "context")
				this.contextTokens = effect.totalTokens;
			else await emit(this.input, effect.event);
		}
		return result;
	}
}

/**
 * The periodic backup of a runner box run's transcript (several MB on long
 * chats), beside the step's reading: awaited inline, every tool call that
 * arrived meanwhile waited for the upload to finish.
 */
class TranscriptBackups {
	private running: Promise<void> | undefined;
	private last: number;
	constructor(
		private readonly input: ClaudeCodeStepInput,
		private readonly home: string,
		private readonly now: () => number,
	) {
		const savedAt = lastTranscriptSaves.get(input.turnId);
		this.last = savedAt !== undefined && savedAt <= now() ? savedAt : now();
		lastTranscriptSaves.set(input.turnId, this.last);
	}
	/** No backup running or due: the step may end early. */
	idle() {
		return (
			!this.running &&
			(!this.input.remote ||
				this.now() - this.last < TRANSCRIPT_SAVE_INTERVAL_MS)
		);
	}
	/** Starts the next backup when one is due on a runner box. */
	maybeStart(claudeSessionId: string | null) {
		if (
			!this.input.remote ||
			this.running ||
			!claudeSessionId ||
			!isClaudeCodeSessionId(claudeSessionId) ||
			this.now() - this.last < TRANSCRIPT_SAVE_INTERVAL_MS
		)
			return;
		this.last = this.now();
		lastTranscriptSaves.set(this.input.turnId, this.last);
		this.running = saveTranscript(this.input, this.home, claudeSessionId)
			.catch((error: unknown) =>
				console.warn("Claude Code transcript was not saved.", {
					message:
						error instanceof Error ? error.message.slice(0, 200) : "unknown",
				}),
			)
			.finally(() => {
				this.running = undefined;
			});
	}
	/** Nothing of a step may outlive it in the chat's object. */
	async settled() {
		await this.running;
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
	timeoutMs: number,
): Promise<{ home: string; state: RunState }> {
	const output = await checked(
		shell,
		`printf '%s\\n' "$HOME"; d="$HOME/${RUNS}/${turnId}"; n=$(cat "$d/current" 2>/dev/null || true); printf '%s\\n' "$n"; if [ -n "$n" ]; then [ -f "$d/$n/consumed" ] && echo consumed || echo active; cat "$d/session" 2>/dev/null || true; fi`,
		"its state could not be read.",
		timeoutMs,
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

/** Where the runner box keeps each version of the box tool server. */
const BOX_TOOLS_DIRECTORY = ".ytimesy/claude-box-tools";

/**
 * Puts the box tool server's bundle on the runner box (once per version) and
 * mints the run's grant. Null, logged, when either fails: the run then uses
 * the edge's tools, as without box tools. The token is redacted from the
 * turn and never logged.
 */
async function prepareBoxTools(
	input: ClaudeCodeStepInput,
	home: string,
): Promise<{ module: string; config: ClaudeBoxToolsConfig } | null> {
	const box = input.boxTools;
	const remote = input.remote;
	if (!box || !remote) return null;
	try {
		const bundle = box.bundle();
		if (!/^[a-f0-9]{16,64}$/.test(bundle.version))
			throw new Error("the box tool bundle has no version");
		const module = `${home}/${BOX_TOOLS_DIRECTORY}/${bundle.version}.mjs`;
		const present = await input.shell(`test -s ${quote(module)}`, 30_000);
		if (present.exitCode !== 0) await input.writeFile(module, bundle.source);
		const grant = await box.grant();
		if (!grant) return null;
		input.addRedaction?.(grant.token);
		return {
			module,
			config: {
				token: grant.token,
				vmId: grant.vmId,
				linuxUser: grant.linuxUser,
				cwd: remote.repository,
				sessionId: input.sessionId,
				turnId: input.turnId,
				shape: box.shape,
				tools: box.tools,
				redact: box.redact(),
				...(grant.redactOnVm ? { redactOnVm: true } : {}),
			},
		};
	} catch (error) {
		console.warn("Claude box tools were not prepared; the edge serves them.", {
			turnId: input.turnId,
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
		return null;
	}
}

/** The box tools each run served, by `turn:run`, as its runner wrote them. */
const boxToolRuns = new Map<string, Promise<ReadonlySet<string>>>();

/**
 * The tools a run served on its box (CLAUDE_BOX_TOOLS_ACTIVE), read once per
 * run: none when the file is missing (box tools off or not started), so the
 * edge's bridge shows every call as before.
 */
function boxToolsOfRun(
	input: ClaudeCodeStepInput,
	key: string,
	runDirectory: string,
): Promise<ReadonlySet<string>> {
	let found = boxToolRuns.get(key);
	if (!found) {
		found = input
			.shell(
				`cat -- ${quote(`${runDirectory}/${CLAUDE_BOX_TOOLS_ACTIVE}`)} 2>/dev/null; true`,
				15_000,
			)
			.then(({ stdout }) => {
				const names = stdout.trim() ? (JSON.parse(stdout) as unknown) : [];
				return new Set(
					Array.isArray(names)
						? names.filter((name): name is string => typeof name === "string")
						: [],
				);
			});
		// A failed read is asked again on the next line.
		found.catch(() => boxToolRuns.delete(key));
		boxToolRuns.set(key, found);
		if (boxToolRuns.size > 500)
			boxToolRuns.delete(boxToolRuns.keys().next().value as string);
	}
	return found;
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
		input.issueGrant
			? input.issueGrant()
			: issueClaudeCodeGrant(requiredGrantSecret(input.grantSecret), {
					userId: input.userId,
					sessionId: input.sessionId,
					turnId: input.turnId,
				}),
	]);
	if (sdk === "pending") return { pending: true };
	const request = claudeCodePrompt(input.messages, Boolean(resumeId));
	if (!request.trim()) return null;
	// A resumed session carries its earlier answers, which may still say "gh is
	// not logged in"; the newest message is what the model weighs most.
	const prompt =
		resumeId && !input.reader && !input.ySquared
			? `${PULL_REQUEST_REMINDER(input.pullRequestNote)}\n\n${request}`
			: request;
	input.addRedaction?.(grant);
	const boxTools =
		input.remote && input.boxTools && !input.reader
			? await prepareBoxTools(input, home)
			: null;
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
			contents: systemPrompt(
				input.cwd,
				input.reader,
				input.remote,
				input.ySquared,
				input.pullRequestNote,
				input.secretsLine,
				input.delegation,
			),
		},
		{ path: `${runDirectory}/prompt`, contents: prompt },
		{
			path: `${runDirectory}/options.json`,
			contents: JSON.stringify({
				model: input.modelId,
				effort: input.effort ?? null,
				disallowedTools: input.ySquared
					? CLAUDE_RUNNER_Y_SQUARED_DISALLOWED_TOOLS
					: CLAUDE_RUNNER_DISALLOWED_TOOLS,
				// Y²: an empty list switches every built-in tool off, leaving
				// only the MCP server's.
				...(input.ySquared ? { builtInTools: [] } : {}),
				resume: resumeId ?? null,
				// The runner pushes its lines to the chat's object; authenticated
				// with the grant in mcp.json.
				...(input.feed
					? {
							feed: {
								url: `${input.edgeOrigin.replace(/^http/, "ws")}${CLAUDE_CODE_FEED_PATH}`,
								turnId: input.turnId,
								run,
							},
						}
					: {}),
				...(boxTools
					? {
							boxTools: {
								module: boxTools.module,
								config: CLAUDE_BOX_TOOLS_CONFIG,
							},
						}
					: {}),
			}),
		},
		// The identity token, read and deleted by the runner when it starts.
		...(boxTools
			? [
					{
						path: `${runDirectory}/${CLAUDE_BOX_TOOLS_CONFIG}`,
						contents: JSON.stringify(boxTools.config),
					},
				]
			: []),
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
		if (isDirectTranscriptPath(record.transcriptPath)) {
			await restoreDirectTranscript(input, home, record.transcriptPath, path);
			return record.claudeSessionId;
		}
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

/** Where a direct transfer's one-use config (a presigned URL and key) is written on the VM. */
function directConfigPath(home: string) {
	return `${home}/.ytimesy/claude-direct/${crypto.randomUUID()}.json`;
}
const DIRECT_TRANSFER_MS = 240_000;

/**
 * Runs one direct transfer on the VM: writes its config to a private file
 * (the script deletes it first thing), runs the command, and removes the file
 * again whatever happens. Throws only a generic message, never the command.
 */
async function runDirectTransfer(
	input: ClaudeCodeStepInput,
	home: string,
	config: Record<string, string>,
	command: (configPath: string) => string,
) {
	const configPath = directConfigPath(home);
	try {
		await checked(
			input.shell,
			`umask 077; mkdir -p ${quote(configPath.slice(0, configPath.lastIndexOf("/")))}`,
			"could not prepare a direct transfer.",
		);
		await input.writeFile(configPath, JSON.stringify(config));
		const result = await input.shell(command(configPath), DIRECT_TRANSFER_MS);
		if (result.exitCode !== 0) throw new Error("the direct transfer failed.");
	} finally {
		await input
			.shell(`rm -f ${quote(configPath)}`, 15_000)
			.catch(() => undefined);
	}
}

/**
 * Backs up a transcript too large for the Durable Object by encrypting and
 * uploading it on the VM. Returns its object path, or null (never throws) when
 * that is not possible, so the caller keeps the previous backup.
 */
async function saveTranscriptDirect(
	input: ClaudeCodeStepInput,
	home: string,
	claudeSessionId: string,
	source: string,
): Promise<string | null> {
	try {
		const prepared = await input.store.direct?.prepareUpload(claudeSessionId);
		if (!prepared) return null;
		await runDirectTransfer(input, home, prepared.config, (configPath) =>
			directUploadCommand(configPath, source),
		);
		return prepared.path;
	} catch (error) {
		console.warn("Claude Code transcript could not be backed up directly.", {
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		});
		return null;
	}
}

async function restoreDirectTranscript(
	input: ClaudeCodeStepInput,
	home: string,
	objectPath: string,
	destination: string,
) {
	const prepared = await input.store.direct?.prepareDownload(objectPath);
	if (!prepared) throw new Error("its direct backup is unavailable.");
	await checked(
		input.shell,
		`umask 077; mkdir -p ${quote(destination.slice(0, destination.lastIndexOf("/")))}`,
		"could not restore its session.",
	);
	await runDirectTransfer(input, home, prepared.config, (configPath) =>
		directDownloadCommand(configPath, destination),
	);
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
	if (bytes > INLINE_TRANSCRIPT_BYTES && bytes <= MAX_DIRECT_TRANSCRIPT_BYTES) {
		const direct = await saveTranscriptDirect(
			input,
			home,
			claudeSessionId,
			source,
		);
		if (direct) {
			await input.store.saveSession({
				claudeSessionId,
				transcriptPath: direct,
				cwd: input.cwd,
			});
			return;
		}
	}
	if (bytes > INLINE_TRANSCRIPT_BYTES) {
		console.warn("Claude Code transcript is too large to back up inline.", {
			bytes,
			limit: INLINE_TRANSCRIPT_BYTES,
		});
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
		`${commit >= 0 ? `printf '%s' ${commit} > ${quote(`${runDirectory}/offset`)}; ` : ""}: > ${quote(`${runDirectory}/consumed`)}; rm -f ${quote(`${runDirectory}/env`)} ${quote(`${runDirectory}/mcp.json`)} ${quote(`${runDirectory}/${CLAUDE_BOX_TOOLS_CONFIG}`)}; true`,
		15_000,
	).catch(() => undefined);
}

async function completeRun(
	input: ClaudeCodeStepInput,
	result: ClaudeCodeResult,
	home: string,
	apiError: string | null,
	contextTokens: number | null = null,
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
	// The composer's context ring: how full the window is after this run.
	if (contextTokens !== null && result.contextWindow)
		await input.onEvent({
			type: "context",
			compacting: false,
			context: {
				last: { totalTokens: contextTokens },
				modelContextWindow: result.contextWindow,
			},
		});
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
		`d="$HOME"/${RUNS}/${turnId}; n=$(cat "$d/current" 2>/dev/null || true); case "$n" in ''|*[!0-9]*) exit 0;; esac; python3 -c ${quote(COMMAND_STOP_SCRIPT)} ${quote(root)} "cc-${turnId}-$n"; : > "$d/$n/consumed"; rm -f "$d/$n/env" "$d/$n/mcp.json" "$d/$n/${CLAUDE_BOX_TOOLS_CONFIG}"; true`,
		20_000,
	);
}
