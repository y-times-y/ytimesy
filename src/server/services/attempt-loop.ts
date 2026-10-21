import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import type { ApiTokenUsage } from "#/domain/api-token-usage";
import {
	ATTEMPT_LOOP_LIMITS,
	ATTEMPT_TESTS_ROOT,
	type AttemptCandidate,
	type AttemptLoopState,
	type AttemptSelectionRecord,
	type AttemptSnapshot,
	type AttemptSpend,
	attemptCheckerBrief,
	attemptCutOff,
	attemptDirectory,
	attemptJudgeBrief,
	attemptLoopSummary,
	attemptRef,
	type CheckerVerdict,
	decideAfterCheck,
	type LoopChildModel,
	loopTokens,
	meanAttemptStats,
	NO_ATTEMPT_SPEND,
	parseCheckerVerdict,
	parseJudgeWinner,
	parseSuiteOutput,
	type ResetReport,
	retryNotice,
	type SelectionCandidate,
	type SuiteRun,
	selectCandidate,
	selectionReserveMs,
	usageSince,
} from "#/domain/attempt-loop";
import { ATTEMPT_CHECK_TOOL } from "#/domain/check-summary";
import { SessionItemId } from "#/domain/ids";
import {
	type ModelBilling,
	modelBilling,
	usageCostUsd,
} from "#/domain/model-pricing";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import type { ModelRole } from "#/domain/role-models";
import {
	type SessionItem,
	sessionItemsFromUnknown,
} from "#/domain/session-item";
import type { SubagentBudget } from "#/domain/subagent";
import {
	READER_LINUX_USER,
	readerUserSetupCommand,
} from "#/domain/subagent-reader";
import { sessionTokenUsage } from "#/domain/subagent-usage";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/**
 * The attempt loop's runtime (harness variant attempts=3; pure rules in
 * src/domain/attempt-loop.ts). It runs inside the root builder's durable
 * turn and needs no decision from the builder:
 *
 * 1. Checkpoint: before the first model step, the working tree is captured
 *    as a commit (refs/ytimesy/attempts/<turn>-base) and the listening
 *    processes are recorded.
 * 2. Attempt: an ordinary builder run until its final answer.
 * 3. Check: the attempt is saved as a candidate ref and a checker subagent
 *    (read-only, on this VM) gets a runtime-built brief: the request
 *    verbatim and the delivered change, never the builder's reasoning. It
 *    writes its own acceptance suite (run.sh) and returns a verdict.
 * 4. Decide: pass finishes; fail or unsure retries while attempts, time and
 *    tokens allow: new listeners are stopped, the tree is reset to the
 *    checkpoint and the builder's history is replaced by the request plus a
 *    notice with the findings.
 * 5. Select: every attempt's suite runs against every candidate, the best
 *    score is restored (a judge breaks a tie when time allows).
 *
 * Waiting for a subagent spans durable steps: a step waits until its own
 * deadline and ends with "wait"; the next step resumes the wait.
 */

export type AttemptLoopOutcome =
	| {
			/** Run the model; `messages` replace the history when a new attempt starts. */
			readonly kind: "run";
			readonly messages?: ModelMessage[];
			readonly items?: SessionItem[];
	  }
	/** Still waiting on a checker or judge: end this step, resume in the next. */
	| { readonly kind: "wait"; readonly items?: SessionItem[] }
	/** The loop is over: complete the turn with these items and messages. */
	| {
			readonly kind: "finished";
			readonly messages: ModelMessage[];
			readonly items: SessionItem[];
	  };

export type ShellResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr?: string;
};

export type AttemptLoopDeps = {
	readonly now: () => number;
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly load: (
		sessionId: string,
		turnId: string,
	) => Promise<AttemptLoopState | null>;
	readonly save: (sessionId: string, state: AttemptLoopState) => Promise<void>;
	/** An eval runner's deadline for the loop (it only shortens the default). */
	readonly runnerDeadline: (sessionId: string) => Promise<number | null>;
	readonly capture: (
		workspace: AgentToolWorkspace,
		ref: string,
	) => Promise<AttemptSnapshot>;
	readonly startSubagent: (input: {
		readonly role: "checker" | "reviewer";
		/** The roleModels entry that applies (the tiebreak judge passes "judge"). */
		readonly modelRole?: ModelRole;
		readonly title: string;
		readonly brief: string;
		readonly cap: Partial<SubagentBudget>;
	}) => Promise<{
		readonly sessionId: string;
		/** The child's model when the runtime knows it (priced at its own route). */
		readonly model?: Omit<LoopChildModel, "notice">;
		readonly notice?: string;
	}>;
	readonly takeReport: (
		parentSessionId: string,
		childSessionId: string,
	) => Promise<{ outcome: "completed" | "failed"; report: string } | null>;
	readonly childItems: (childSessionId: string) => Promise<unknown>;
	readonly stopChild: (childSessionId: string) => Promise<void>;
	/** Runs on the VM as the builder's user (git, directories). */
	readonly vm: (command: string, timeoutMs: number) => Promise<ShellResult>;
	/** Runs like a builder command: in the project's environment (a benchmark's container). */
	readonly routed: (command: string, seconds: number) => Promise<ShellResult>;
	/** Stops the turn's owned commands still running (a cut-off attempt). */
	readonly stopOwnedCommands: () => Promise<void>;
};

export type AttemptLoopInput = {
	readonly sessionId: string;
	readonly turnId: string;
	readonly max: number;
	readonly workspace: () => Promise<AgentToolWorkspace>;
	readonly signal: AbortSignal;
	readonly billing: ModelBilling;
	/** The user's request this turn answers, verbatim. */
	readonly taskText: () => string;
	/** Whether a model message is a user request (not runtime context). */
	readonly isRequest: (message: ModelMessage) => boolean;
	readonly deps: AttemptLoopDeps;
	/** Harness variant rigor=on: the checker's brief gets the rigor checks. */
	readonly rigor?: boolean;
};

type Taken = {
	readonly outcome: "completed" | "failed";
	readonly report: string;
	readonly timedOut?: boolean;
};

const prefixHash = (messages: readonly ModelMessage[]) =>
	createHash("sha256").update(JSON.stringify(messages)).digest("hex");

type StepInput = {
	readonly messages: ModelMessage[];
	readonly items: SessionItem[];
	/** Latest time this step may keep waiting. */
	readonly waitUntil: number;
};

const GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false";
const NOT_RESET = [
	"ignored files (dependencies, build output, caches)",
	"files outside the checkout",
	"databases and other services' data",
];

/**
 * Restores a snapshot: HEAD (and its branch) to the snapshot's commit, the
 * index and working tree to its trees, untracked non-ignored files removed.
 * Ignored files are kept (dependencies, credentials).
 */
const RESTORE_SCRIPT = `import fcntl,hashlib,os,pathlib,subprocess,sys
root,ref,tree,index,head,branch=sys.argv[1:7]
root=str(pathlib.Path(root).resolve(strict=True))
lock=open('/tmp/ytimesy-edit-lock-'+hashlib.sha256(root.encode()).hexdigest(),'a');fcntl.flock(lock,fcntl.LOCK_EX)
def git(*args):return subprocess.check_output(['git','-C',root,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args])
if git('rev-parse',ref+'^{tree}').decode().strip()!=tree:raise SystemExit('snapshot ref changed')
if branch:
 if subprocess.run(['git','-C',root,'symbolic-ref','-q','HEAD'],capture_output=True).stdout.decode().strip()!=branch:git('symbolic-ref','HEAD',branch)
 git('update-ref',branch,head)
else:git('update-ref','--no-deref','HEAD',head)
git('read-tree',tree)
for name in git('ls-files','--others','--exclude-standard','-z').decode().split('\\0'):
 if not name:continue
 path=pathlib.Path(root)/name
 if path.is_file() or path.is_symlink():path.unlink()
git('restore','--source='+tree,'--worktree','--','.')
git('read-tree',index)
print('restored')`;

/** Listening sockets' processes (from /proc, so it works without ss). */
const LISTENERS_SCRIPT = `import json,os,signal,sys
def listening():
 inodes={}
 for name in ('/proc/net/tcp','/proc/net/tcp6'):
  try:lines=open(name).read().splitlines()[1:]
  except OSError:continue
  for line in lines:
   parts=line.split()
   if len(parts)>9 and parts[3]=='0A':inodes[parts[9]]=int(parts[1].rsplit(':',1)[1],16)
 found={}
 try:pids=os.listdir('/proc')
 except OSError:return found
 for pid in pids:
  if not pid.isdigit():continue
  try:fds=os.listdir('/proc/'+pid+'/fd')
  except OSError:continue
  for fd in fds:
   try:target=os.readlink('/proc/'+pid+'/fd/'+fd)
   except OSError:continue
   if target.startswith('socket:[') and target[8:-1] in inodes:found[int(pid)]=inodes[target[8:-1]]
 return found
now=listening()
if sys.argv[1]=='list':print(json.dumps(sorted(now)));sys.exit(0)
keep=set(json.loads(sys.argv[2]));ancestors=set();pid=os.getpid()
while pid>1:
 ancestors.add(pid)
 try:pid=int(open('/proc/%d/stat'%pid).read().rsplit(')',1)[1].split()[1])
 except Exception:break
stopped=[]
for pid,port in sorted(now.items()):
 if pid<=1 or pid in keep or pid in ancestors:continue
 try:comm=open('/proc/%d/comm'%pid).read().strip()
 except OSError:comm='?'
 if any(word in comm for word in ('chrome','chromium','playwright','ytimesy','sshd','dockerd','containerd')):continue
 try:os.kill(pid,signal.SIGTERM);stopped.append('%s on port %d'%(comm,port))
 except OSError:pass
print(json.dumps(stopped))`;

export function restoreSnapshotCommand(
	snapshot: AttemptSnapshot,
	branch: string,
) {
	return `python3 -c ${quote(RESTORE_SCRIPT)} ${quote(snapshot.cwd)} ${quote(snapshot.ref)} ${quote(snapshot.tree)} ${quote(snapshot.indexTree)} ${quote(snapshot.head)} ${quote(branch)}`;
}

/**
 * Creates a runtime checker's directory under ATTEMPT_TESTS_ROOT, owned by
 * the reader user (its only writable place besides its scratch). The root is
 * shared with a benchmark's task container.
 *
 * The reader user is created first: on a VM booted from an image older than
 * the reader user the ownership step failed, and the fallback then failed
 * too because the root had just been made root-owned 0755 (every review=on
 * check in hs30b-rvon ended "the checker's directory could not be created").
 * The root and the turn's directory stay sticky and world-writable like /tmp,
 * so the fallback works as the builder's user and the container keeps access.
 */
export function checkerDirectoryCommand(directory: string) {
	const parent = directory.slice(0, directory.lastIndexOf("/"));
	const shared = `${quote(ATTEMPT_TESTS_ROOT)} ${quote(parent)}`;
	return [
		`{ ${readerUserSetupCommand()} && sudo -n install -d ${shared} && sudo -n chmod 1777 ${shared} && sudo -n install -d -o ${READER_LINUX_USER} -g ${READER_LINUX_USER} -m 0755 ${quote(directory)}; } >/dev/null 2>&1`,
		`|| { mkdir -p ${quote(directory)} && chmod 0777 ${quote(directory)}; }`,
	].join(" ");
}

export function listenersCommand(keep?: readonly number[]) {
	return keep
		? `python3 -c ${quote(LISTENERS_SCRIPT)} stop ${quote(JSON.stringify(keep))}`
		: `python3 -c ${quote(LISTENERS_SCRIPT)} list`;
}

/** One suite against the checkout as it is now; its PASS/FAIL lines and exit code. */
export function suiteCommand(testsPath: string, cwd: string, seconds: number) {
	const runner = `${testsPath}/run.sh`;
	return [
		`if [ ! -f ${quote(runner)} ]; then echo "__SUITE_MISSING"; exit 0; fi`,
		`if command -v timeout >/dev/null 2>&1; then timeout -k 5 ${seconds} bash ${quote(runner)} ${quote(cwd)} > /tmp/ytimesy-suite.$$ 2>&1; rc=$?; else bash ${quote(runner)} ${quote(cwd)} > /tmp/ytimesy-suite.$$ 2>&1; rc=$?; fi`,
		"grep -E '^[[:space:]]*(PASS|FAIL)\\b' /tmp/ytimesy-suite.$$ | tail -n 400; rm -f /tmp/ytimesy-suite.$$",
		'echo "__SUITE_EXIT=$rc"',
	].join("\n");
}

export function parseSuiteRun(
	output: string,
	suite: number,
	candidate: number,
): SuiteRun | null {
	if (output.includes("__SUITE_MISSING")) return null;
	const exit = /__SUITE_EXIT=(\d+)/.exec(output);
	const exitCode = exit ? Number(exit[1]) : null;
	return {
		suite,
		candidate,
		...parseSuiteOutput(output),
		exitCode,
		timedOut: exitCode === 124 || exitCode === 137,
	};
}

/** The usage the turn has recorded so far (on its user message). */
export function turnUsage(items: readonly SessionItem[]): ApiTokenUsage | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item.kind === "userMessage") return item.apiUsage ?? null;
	}
	return null;
}

/** The attempt's final answer: the last agent message since the request. */
export function attemptReport(items: readonly SessionItem[]) {
	let lastUser = items.length - 1;
	while (lastUser >= 0 && items[lastUser].kind !== "userMessage") lastUser--;
	const messages = items
		.slice(lastUser + 1)
		.filter(
			(item): item is Extract<SessionItem, { kind: "agentMessage" }> =>
				item.kind === "agentMessage" && !!item.text.trim(),
		);
	return messages.at(-1)?.text.trim().slice(-4000) ?? "";
}

/**
 * How many messages precede the first attempt: through the last user
 * request and the runtime context injected right after it, up to the first
 * assistant message. Null when the request is not found (compacted).
 */
export function baseMessageCount(
	messages: readonly ModelMessage[],
	isRequest: (message: ModelMessage) => boolean,
) {
	let request = -1;
	for (let index = messages.length - 1; index >= 0; index--)
		if (isRequest(messages[index])) {
			request = index;
			break;
		}
	if (request < 0) return null;
	let end = request + 1;
	while (end < messages.length && messages[end].role === "user") end++;
	return end;
}

/** A loop child's record of its model, for its state (absent when it runs on the builder's). */
export function loopChildModel(started: {
	readonly model?: Omit<LoopChildModel, "notice">;
	readonly notice?: string;
}): LoopChildModel | undefined {
	if (!started.model) return undefined;
	return started.notice
		? { ...started.model, notice: started.notice }
		: started.model;
}

/** A child's billing: its own route's when recorded, else the builder's. */
export function childBilling(
	model: LoopChildModel | undefined,
	builder: ModelBilling,
): ModelBilling {
	return model
		? modelBilling({ harness: model.harness, modelId: model.modelId })
		: builder;
}

function spendOf(
	usage: ApiTokenUsage | null | undefined,
	billing: ModelBilling,
): AttemptSpend {
	if (!usage) return NO_ATTEMPT_SPEND;
	return {
		tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
		costUsd: usageCostUsd(usage, billing),
		estimated: billing.kind === "plan",
	};
}

/** Per-attempt and total spend of a loop (builder + checker + judge). */
export function attemptLoopSpend(
	state: AttemptLoopState,
	billing: ModelBilling,
) {
	const attempts = state.candidates.map((candidate) => {
		const builder = spendOf(candidate.builderUsage, billing);
		const checker = spendOf(
			candidate.checker?.usage,
			childBilling(candidate.checker?.model, billing),
		);
		const total: AttemptSpend = {
			tokens: builder.tokens + checker.tokens,
			costUsd:
				builder.costUsd === null || checker.costUsd === null
					? null
					: builder.costUsd + checker.costUsd,
			estimated: builder.estimated || checker.estimated,
		};
		return {
			n: candidate.n,
			builder,
			checker,
			total,
			ms:
				(candidate.checker?.endedAt ?? candidate.endedAt) - candidate.startedAt,
		};
	});
	const judge = spendOf(
		state.selection?.judge?.usage,
		childBilling(state.selection?.judge?.model, billing),
	);
	const total = attempts.reduce(
		(sum, attempt) => ({
			tokens: sum.tokens + attempt.total.tokens,
			costUsd:
				sum.costUsd === null || attempt.total.costUsd === null
					? null
					: sum.costUsd + attempt.total.costUsd,
			estimated: sum.estimated || attempt.total.estimated,
		}),
		judge,
	);
	return { attempts, judge, total };
}

function summaryItem(
	state: AttemptLoopState,
	billing: ModelBilling,
	id: string,
): SessionItem {
	const spend = attemptLoopSpend(state, billing);
	const dollars = (value: number | null, estimated: boolean) =>
		value === null ? "" : ` · ${estimated ? "~" : ""}$${value.toFixed(2)}`;
	return {
		kind: "dynamicToolCall",
		id: SessionItemId(id),
		tool: ATTEMPT_CHECK_TOOL,
		input: `${state.candidates.length} of up to ${state.max} attempts`,
		output: [
			attemptLoopSummary(state),
			...(state.selection
				? [`Selection: ${state.selection.explanation}.`]
				: []),
			`Spent ${Math.round(spend.total.tokens / 1000)}k tokens${dollars(spend.total.costUsd, spend.total.estimated)}.`,
		].join("\n"),
		status: "completed",
	};
}

export function createAttemptLoop(input: AttemptLoopInput) {
	const { deps, sessionId, turnId } = input;
	const reserve = (state: AttemptLoopState) =>
		selectionReserveMs(state.deadlineAt - state.startedAt);
	let branchMemo: string | undefined;

	const save = async (state: AttemptLoopState) => {
		await deps.save(sessionId, state);
		return state;
	};

	async function branch(workspace: AgentToolWorkspace) {
		if (branchMemo !== undefined) return branchMemo;
		const result = await deps.vm(
			`${GIT} -C ${quote(workspace.cwd)} symbolic-ref -q HEAD || true`,
			15_000,
		);
		branchMemo = result.stdout.trim();
		return branchMemo;
	}

	async function restore(
		workspace: AgentToolWorkspace,
		snapshot: AttemptSnapshot,
	) {
		const result = await deps.vm(
			restoreSnapshotCommand(snapshot, await branch(workspace)),
			60_000,
		);
		if (result.exitCode !== 0 || !result.stdout.includes("restored"))
			throw new Error(
				`The attempt loop could not restore ${snapshot.ref}: ${(result.stderr ?? result.stdout).slice(-300)}`,
			);
	}

	async function listeners(): Promise<number[]> {
		const result = await deps
			.routed(listenersCommand(), 20)
			.catch(() => ({ exitCode: 1, stdout: "" }));
		try {
			const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
			return Array.isArray(parsed) ? parsed.filter(Number.isInteger) : [];
		} catch {
			return [];
		}
	}

	/** Stops servers the attempt left listening and resets the tree to the checkpoint. */
	async function resetToCheckpoint(
		state: AttemptLoopState,
		workspace: AgentToolWorkspace,
	): Promise<ResetReport> {
		let stopped: string[] = [];
		const result = await deps
			.routed(listenersCommand(state.listenersAtStart), 20)
			.catch(() => null);
		try {
			const parsed = JSON.parse(
				result?.stdout.trim().split("\n").at(-1) ?? "[]",
			);
			if (Array.isArray(parsed))
				stopped = parsed.filter(
					(entry): entry is string => typeof entry === "string",
				);
		} catch {}
		await restore(workspace, state.checkpoint);
		return { stoppedListeners: stopped, notReset: NOT_RESET };
	}

	/** Step 1: the checkpoint, before the builder changes anything. */
	async function begin(step: StepInput): Promise<AttemptLoopState> {
		const workspace = await input.workspace();
		const now = deps.now();
		const runner = await deps.runnerDeadline(sessionId).catch(() => null);
		const deadlineAt = Math.min(
			now + ATTEMPT_LOOP_LIMITS.loopMinutes * 60_000,
			runner ?? Number.POSITIVE_INFINITY,
		);
		const checkpoint = await deps.capture(
			workspace,
			attemptRef(turnId, "base"),
		);
		return save({
			version: 1,
			turnId,
			max: input.max,
			phase: "attempting",
			attempt: 1,
			startedAt: now,
			deadlineAt,
			tokenBudget: ATTEMPT_LOOP_LIMITS.tokens,
			checkpoint,
			listenersAtStart: await listeners(),
			baseMessageCount: null,
			attemptStartedAt: now,
			usageAtAttemptStart: turnUsage(step.items),
			candidates: [],
		});
	}

	/** The attempt's directory, owned by the reader so its checker can write there. */
	async function prepareDirectory(directory: string) {
		const result = await deps.vm(checkerDirectoryCommand(directory), 20_000);
		if (result.exitCode !== 0)
			throw new Error("The checker's directory could not be created.");
	}

	/** Step 3: save the attempt as a candidate and start its checker. */
	async function check(
		state: AttemptLoopState,
		step: StepInput,
		cutOff: boolean,
	): Promise<AttemptLoopState> {
		const workspace = await input.workspace();
		const n = state.attempt;
		const now = deps.now();
		const snapshot = await deps.capture(
			workspace,
			attemptRef(turnId, String(n)),
		);
		const usage = turnUsage(step.items);
		let candidate: AttemptCandidate = {
			n,
			startedAt: state.attemptStartedAt,
			endedAt: now,
			snapshot,
			cutOff,
			report: attemptReport(step.items),
			builderUsage: usageSince(usage, state.usageAtAttemptStart),
			checker: null,
			verdict: null,
		};
		const base =
			state.candidates.length || state.baseMessageCount !== null
				? { count: state.baseMessageCount, hash: state.baseMessageHash }
				: (() => {
						const count = baseMessageCount(step.messages, input.isRequest);
						return {
							count,
							hash:
								count === null
									? null
									: prefixHash(step.messages.slice(0, count)),
						};
					})();
		const unchanged = snapshot.tree === state.checkpoint.tree;
		if (cutOff || unchanged) {
			return save({
				...state,
				baseMessageCount: base.count,
				baseMessageHash: base.hash,
				candidates: [...state.candidates, candidate],
			});
		}
		const directory = attemptDirectory(turnId, n);
		await prepareDirectory(directory);
		const changed = await deps.vm(
			`${GIT} -C ${quote(workspace.cwd)} diff --name-only ${quote(state.checkpoint.ref)} ${quote(snapshot.ref)}`,
			30_000,
		);
		const remainingMinutes = Math.max(
			1,
			(state.deadlineAt - now - reserve(state)) / 60_000 / 2,
		);
		const checker = await deps.startSubagent({
			role: "checker",
			title: `Check attempt ${n} of ${state.max}`,
			brief: attemptCheckerBrief({
				taskText: input.taskText(),
				checkout: workspace.cwd,
				changedFiles: changed.stdout.split("\n").filter(Boolean),
				base: state.checkpoint.ref,
				candidate: snapshot.ref,
				directory,
				rigor: input.rigor,
			}),
			cap: {
				...ATTEMPT_LOOP_LIMITS.checker,
				minutes: Math.min(
					ATTEMPT_LOOP_LIMITS.checker.minutes,
					remainingMinutes,
				),
			},
		});
		candidate = {
			...candidate,
			checker: {
				sessionId: checker.sessionId,
				startedAt: now,
				directory,
				...(loopChildModel(checker) ? { model: loopChildModel(checker) } : {}),
			},
		};
		return save({
			...state,
			phase: "checking",
			baseMessageCount: base.count,
			baseMessageHash: base.hash,
			candidates: [...state.candidates, candidate],
		});
	}

	/** Waits for a runtime child's report until the step's deadline. */
	async function awaitReport(
		childId: string,
		state: AttemptLoopState,
		waitUntil: number,
	): Promise<Taken | null> {
		let stopAsked = false;
		while (!input.signal.aborted) {
			const taken = await deps.takeReport(sessionId, childId);
			if (taken) return taken;
			const now = deps.now();
			// The child's own budget ends it; this only guards the loop's deadline.
			if (!stopAsked && now >= state.deadlineAt - reserve(state) * 0.7) {
				stopAsked = true;
				await deps.stopChild(childId).catch(() => {});
			}
			if (now >= state.deadlineAt - reserve(state) * 0.4)
				return { outcome: "failed", report: "", timedOut: true };
			if (now >= waitUntil) return null;
			await deps.sleep(
				Math.min(3_000, Math.max(250, waitUntil - now)),
				input.signal,
			);
		}
		input.signal.throwIfAborted();
		return null;
	}

	async function childUsage(childId: string) {
		return sessionTokenUsage(
			sessionItemsFromUnknown(await deps.childItems(childId).catch(() => [])),
		);
	}

	function withCandidate(
		state: AttemptLoopState,
		n: number,
		update: (candidate: AttemptCandidate) => AttemptCandidate,
	): AttemptLoopState {
		return {
			...state,
			candidates: state.candidates.map((candidate) =>
				candidate.n === n ? update(candidate) : candidate,
			),
		};
	}

	/** Step 4: decide after a verdict. */
	async function decide(
		state: AttemptLoopState,
		verdict: CheckerVerdict,
		step: StepInput,
	): Promise<AttemptLoopOutcome> {
		const now = deps.now();
		const stats = meanAttemptStats(state);
		const decision = decideAfterCheck({
			verdict: verdict.verdict,
			attempt: state.attempt,
			max: state.max,
			now,
			deadlineAt: state.deadlineAt,
			reserveMs: reserve(state),
			meanAttemptMs: stats.ms,
			spentTokens: loopTokens(state),
			meanAttemptTokens: stats.tokens,
			tokenBudget: state.tokenBudget,
		});
		if (decision.kind === "finish")
			return finish(
				{
					...state,
					phase: "done",
					kept: state.attempt,
					finishedAt: now,
				},
				step,
			);
		if (decision.kind === "select") return select(state, step, decision.reason);
		const workspace = await input.workspace();
		const reset = await resetToCheckpoint(state, workspace);
		const failed = state.candidates.find((c) => c.n === state.attempt);
		const next = state.attempt + 1;
		const notice = retryNotice({
			failed: state.attempt,
			next,
			max: state.max,
			verdict,
			previousReport: failed?.report ?? "",
			reset,
			earlier: state.candidates
				.filter((c) => c.n < state.attempt && c.verdict)
				.map((c) => ({
					n: c.n,
					failures: c.verdict?.failures ?? [],
				})),
		});
		// The next attempt sees the request and the notice, not the failed
		// attempt's trail. A compacted history no longer has that prefix: then
		// the request is looked up again, or the whole history is kept.
		const stored = state.baseMessageCount;
		const base =
			stored !== null &&
			stored <= step.messages.length &&
			prefixHash(step.messages.slice(0, stored)) === state.baseMessageHash
				? stored
				: baseMessageCount(step.messages, input.isRequest);
		const messages: ModelMessage[] =
			base !== null
				? [...step.messages.slice(0, base), { role: "user", content: notice }]
				: [...step.messages, { role: "user", content: notice }];
		const saved = await save({
			...withCandidate(state, state.attempt, (candidate) => ({
				...candidate,
				reset,
			})),
			phase: "attempting",
			attempt: next,
			attemptStartedAt: deps.now(),
			usageAtAttemptStart: turnUsage(step.items),
		});
		return {
			kind: "run",
			messages,
			items: [
				...step.items,
				summaryItem(
					saved,
					input.billing,
					`attempt-loop:${turnId}:${state.attempt}`,
				),
			],
		};
	}

	/** Step 5: every suite against every candidate; keep the best. */
	async function select(
		state: AttemptLoopState,
		step: StepInput,
		reason: AttemptSelectionRecord["reason"],
	): Promise<AttemptLoopOutcome> {
		const workspace = await input.workspace();
		const notes: string[] = [];
		const candidates = state.candidates;
		// Only the attempt's own directory: a reported path elsewhere is ignored.
		const suites = candidates.flatMap((candidate) =>
			candidate.checker && candidate.verdict
				? [
						{
							n: candidate.n,
							path:
								candidate.verdict.testsPath?.startsWith(
									`${candidate.checker.directory}/`,
								) && !candidate.verdict.testsPath.includes("/../")
									? candidate.verdict.testsPath
									: `${candidate.checker.directory}/tests`,
						},
					]
				: [],
		);
		let runs: SuiteRun[] = [];
		const distinctTrees = new Set(candidates.map((c) => c.snapshot.tree));
		if (suites.length && distinctTrees.size > 1) {
			const budgetMs = Math.max(
				0,
				state.deadlineAt - deps.now() - reserve(state) * 0.25,
			);
			const perRun = Math.max(
				15,
				Math.min(
					ATTEMPT_LOOP_LIMITS.suiteSeconds,
					Math.floor(budgetMs / 1000 / (suites.length * distinctTrees.size)) -
						5,
				),
			);
			let stoppedEarly = false;
			outer: for (const candidate of candidates) {
				if (
					candidates.some(
						(other) =>
							other.n > candidate.n &&
							other.snapshot.tree === candidate.snapshot.tree,
					)
				)
					continue;
				await restore(workspace, candidate.snapshot);
				for (const suite of suites) {
					if (
						deps.now() + perRun * 1000 >
						state.deadlineAt - reserve(state) * 0.2
					) {
						notes.push("Selection stopped early at the deadline.");
						stoppedEarly = true;
						break outer;
					}
					const result = await deps
						.routed(
							suiteCommand(suite.path, workspace.cwd, perRun),
							perRun + 15,
						)
						.catch((error: unknown) => ({
							exitCode: 1,
							stdout: `__SUITE_EXIT=1 ${error instanceof Error ? error.message : ""}`,
						}));
					const run = parseSuiteRun(result.stdout, suite.n, candidate.n);
					if (run) runs.push(run);
					else notes.push(`Attempt ${suite.n}'s checker left no run.sh.`);
				}
			}
			// A partial matrix would compare candidates on different suites:
			// keep only suites that ran against every candidate.
			if (stoppedEarly) {
				const ran = new Set(runs.map((run) => run.candidate));
				runs = runs.filter((run) =>
					[...ran].every((candidate) =>
						runs.some(
							(other) =>
								other.suite === run.suite && other.candidate === candidate,
						),
					),
				);
				const covered = new Set(runs.map((run) => run.candidate));
				if (
					candidates.some(
						(candidate) =>
							!covered.has(candidate.n) &&
							!candidates.some(
								(other) =>
									other.n > candidate.n &&
									other.snapshot.tree === candidate.snapshot.tree,
							),
					)
				)
					runs = [];
			}
		}
		const selectionCandidates: SelectionCandidate[] = candidates.map((c) => ({
			n: c.n,
			verdict: c.verdict?.verdict ?? null,
			ownPassRate: c.verdict?.tests.length
				? c.verdict.tests.filter((test) => test.passed).length /
					c.verdict.tests.length
				: null,
			cutOff: c.cutOff,
			tree: c.snapshot.tree,
		}));
		const result = selectCandidate(selectionCandidates, runs);
		let selection: AttemptSelectionRecord = {
			reason,
			runs,
			scores: result.scores,
			best: result.best,
			runnerUp: result.runnerUp,
			tie: result.tie,
			explanation: result.reason,
			notes: [...new Set(notes)],
		};
		const timeLeft = state.deadlineAt - deps.now() - reserve(state) * 0.3;
		if (
			result.tie &&
			result.runnerUp !== null &&
			timeLeft > ATTEMPT_LOOP_LIMITS.judge.minutes * 60_000 * 0.5
		) {
			const a = candidates.find((c) => c.n === result.best) as AttemptCandidate;
			const b = candidates.find(
				(c) => c.n === result.runnerUp,
			) as AttemptCandidate;
			try {
				const judge = await deps.startSubagent({
					role: "reviewer",
					modelRole: "judge",
					title: `Compare attempts ${a.n} and ${b.n}`,
					brief: attemptJudgeBrief({
						taskText: input.taskText(),
						checkout: workspace.cwd,
						base: state.checkpoint.ref,
						a: { ref: a.snapshot.ref, findings: a.verdict?.failures ?? [] },
						b: { ref: b.snapshot.ref, findings: b.verdict?.failures ?? [] },
					}),
					cap: {
						...ATTEMPT_LOOP_LIMITS.judge,
						minutes: Math.min(
							ATTEMPT_LOOP_LIMITS.judge.minutes,
							Math.max(1, timeLeft / 60_000),
						),
					},
				});
				selection = {
					...selection,
					judge: {
						sessionId: judge.sessionId,
						winner: null,
						...(loopChildModel(judge) ? { model: loopChildModel(judge) } : {}),
					},
				};
				const judging = await save({ ...state, phase: "judging", selection });
				return awaitJudge(judging, step);
			} catch (error) {
				selection = {
					...selection,
					notes: [
						...selection.notes,
						`No tiebreak judge: ${error instanceof Error ? error.message.slice(0, 200) : "unavailable"}.`,
					],
				};
			}
		}
		return keep({ ...state, selection }, step, selection.best);
	}

	async function awaitJudge(
		state: AttemptLoopState,
		step: StepInput,
	): Promise<AttemptLoopOutcome> {
		const selection = state.selection as AttemptSelectionRecord;
		const judge = selection.judge as NonNullable<
			AttemptSelectionRecord["judge"]
		>;
		const taken = await awaitReport(judge.sessionId, state, step.waitUntil);
		if (!taken) return { kind: "wait" };
		const winner = parseJudgeWinner(taken.report);
		const chosen =
			winner === "A"
				? selection.best
				: winner === "B" && selection.runnerUp !== null
					? selection.runnerUp
					: selection.best;
		const usage = await childUsage(judge.sessionId);
		return keep(
			{
				...state,
				selection: {
					...selection,
					best: chosen,
					judge: { ...judge, winner: winner ? chosen : null, usage },
					explanation: `${selection.explanation}; ${winner ? `judge chose attempt ${chosen}` : "judge gave no answer"}`,
				},
			},
			step,
			chosen,
		);
	}

	/** Restores the kept candidate and finishes. */
	async function keep(
		state: AttemptLoopState,
		step: StepInput,
		n: number,
	): Promise<AttemptLoopOutcome> {
		const workspace = await input.workspace();
		const candidate = state.candidates.find(
			(c) => c.n === n,
		) as AttemptCandidate;
		await resetListeners(state);
		await restore(workspace, candidate.snapshot);
		return finish(
			{ ...state, phase: "done", kept: n, finishedAt: deps.now() },
			step,
		);
	}

	async function resetListeners(state: AttemptLoopState) {
		await deps
			.routed(listenersCommand(state.listenersAtStart), 20)
			.catch(() => null);
	}

	async function finish(
		state: AttemptLoopState,
		step: StepInput,
	): Promise<AttemptLoopOutcome> {
		const saved = await save(state);
		const kept = saved.candidates.find((c) => c.n === saved.kept);
		const items: SessionItem[] = [
			...step.items,
			summaryItem(saved, input.billing, `attempt-loop:${turnId}:final`),
		];
		let messages = step.messages;
		const last = saved.candidates.at(-1);
		// The visible answer must describe the tree that was kept.
		if (kept && (kept.n !== last?.n || kept.cutOff)) {
			const text = [
				`Kept attempt ${kept.n} of ${saved.candidates.length}${saved.selection ? ` (${saved.selection.explanation})` : ""}${kept.cutOff ? "; it was cut off by the time limit and is unverified" : ""}.`,
				kept.verdict?.failures.length
					? `Open findings from its independent check:\n${kept.verdict.failures
							.slice(0, 6)
							.map((failure) => `- ${failure}`)
							.join("\n")}`
					: "",
				kept.report ? `Attempt ${kept.n}'s report:\n${kept.report}` : "",
			]
				.filter(Boolean)
				.join("\n\n");
			items.push({
				kind: "agentMessage",
				id: SessionItemId(`attempt-loop:${turnId}:kept`),
				text,
				phase: "final_answer",
			});
			messages = [...messages, { role: "assistant", content: text }];
		}
		return { kind: "finished", messages, items };
	}

	/** Handles the checker's report for the running attempt. */
	async function onCheckerReport(
		state: AttemptLoopState,
		taken: Taken,
		step: StepInput,
	) {
		const n = state.attempt;
		const candidate = state.candidates.find(
			(c) => c.n === n,
		) as AttemptCandidate;
		const checker = candidate.checker as NonNullable<
			AttemptCandidate["checker"]
		>;
		const verdict: CheckerVerdict = taken.timedOut
			? {
					verdict: "unsure",
					failures: [
						"The independent check did not finish before the deadline.",
					],
					tests: [],
					testsPath: null,
					notes: "",
					parsed: false,
				}
			: parseCheckerVerdict(taken.report);
		const now = deps.now();
		const usage = await childUsage(checker.sessionId);
		const updated = await save(
			withCandidate(state, n, (c) => ({
				...c,
				verdict,
				checkMs: now - checker.startedAt,
				checker: { ...checker, endedAt: now, usage },
			})),
		);
		return decide(updated, verdict, step);
	}

	return {
		/** Before a model step: start the loop, resume a wait, or cut off a late attempt. */
		async beforeModel(step: StepInput): Promise<AttemptLoopOutcome> {
			let state = await deps.load(sessionId, turnId);
			if (!state) {
				await begin(step);
				return { kind: "run" };
			}
			if (state.phase === "done") return { kind: "run" };
			if (state.phase === "checking") {
				const candidate = state.candidates.find((c) => c.n === state?.attempt);
				const childId = candidate?.checker?.sessionId;
				if (!childId) return select(state, step, "attempts");
				const taken = await awaitReport(childId, state, step.waitUntil);
				return taken ? onCheckerReport(state, taken, step) : { kind: "wait" };
			}
			if (state.phase === "judging") return awaitJudge(state, step);
			if (
				attemptCutOff({
					now: deps.now(),
					deadlineAt: state.deadlineAt,
					reserveMs: reserve(state),
				})
			) {
				await deps.stopOwnedCommands().catch(() => {});
				state = await check(state, step, true);
				return select(state, step, "time");
			}
			return { kind: "run" };
		},

		/** The builder finished an attempt (final answer, completion gates passed). */
		async afterAttempt(step: StepInput): Promise<AttemptLoopOutcome> {
			let state = await deps.load(sessionId, turnId);
			// Started without a checkpoint (loop enabled mid-turn): nothing to retry against.
			if (!state || state.phase === "done")
				return { kind: "finished", messages: step.messages, items: step.items };
			if (state.phase === "attempting") {
				state = await check(state, step, false);
				// Nothing in the checkout changed (an answer, not a change): nothing to check.
				if (state.phase === "attempting")
					return finish(
						{
							...state,
							phase: "done",
							kept: state.attempt,
							finishedAt: deps.now(),
						},
						step,
					);
			}
			if (state.phase === "judging") return awaitJudge(state, step);
			const candidate = state.candidates.find((c) => c.n === state?.attempt);
			const childId = candidate?.checker?.sessionId;
			if (!childId) return select(state, step, "attempts");
			const taken = await awaitReport(childId, state, step.waitUntil);
			return taken ? onCheckerReport(state, taken, step) : { kind: "wait" };
		},
	};
}

export type AttemptLoop = ReturnType<typeof createAttemptLoop>;
