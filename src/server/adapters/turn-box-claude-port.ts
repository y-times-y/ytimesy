import { issueClaudeCodeGrant } from "#/domain/claude-code-grant";
import { claudeSubscriptionEnabled } from "#/domain/claude-code-route";
import {
	type ClaudeRunnerBox,
	claudeRunnerFor,
	claudeRunnerUrls,
} from "#/domain/claude-runner";
import { isReaderRole } from "#/domain/subagent";
import {
	type BoxPortArgs,
	TurnBoxPortForbidden,
} from "#/domain/turn-box-protocol";
import { agentSessionMetadataForOwner } from "./agent-sessions";
import type { ApiTurn } from "./api-turns";
import { downloadCheckpoint, uploadCheckpoint } from "./checkpoints/storage";
import {
	claudeRunnerDiskShare,
	claudeRunnerMachine,
} from "./claude-runner-box";
import {
	claudeSubscriptionStatus,
	readClaudeCodeSession,
	saveClaudeCodeSession,
} from "./claude-subscription";
import { gitProxyConfiguration } from "./github/git-proxy-transfer";

/**
 * A Claude Code turn whose step runs on a turn runner box
 * (docs/turn-runner-boxes.md, "Claude Code on a box"). The box holds none of
 * the edge's secrets: the edge picks the chat's Claude runner box and signs
 * each command for it (YTIMESY_CLAUDE_RUNNER_SIGNING_KEY), mints the run's
 * grant (the git proxy secret), and reads and writes the chat's Claude
 * session record and transcripts. The user, chat and turn are the lease's;
 * a runner the box names must be one of the configured runners or the
 * chat's own pinned one.
 */
export type ClaudePortCall = BoxPortArgs<"claude">;

export type TurnBoxClaudeDeps = {
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The chat's durable runner placement (its Durable Object): the pinned origin for a candidate. */
	readonly placement?: (turn: ApiTurn, candidate: string) => Promise<string>;
	readonly machine?: typeof claudeRunnerMachine;
	readonly disk?: typeof claudeRunnerDiskShare;
	readonly owner?: typeof agentSessionMetadataForOwner;
	readonly sessions?: {
		readonly read: typeof readClaudeCodeSession;
		readonly save: typeof saveClaudeCodeSession;
	};
	readonly checkpoints?: {
		readonly upload: typeof uploadCheckpoint;
		readonly download: typeof downloadCheckpoint;
	};
	readonly subscription?: typeof claudeSubscriptionStatus;
	readonly grantSecret?: () => string | null;
};

export async function claudePort(
	turn: ApiTurn,
	call: ClaudePortCall,
	deps: TurnBoxClaudeDeps = {},
): Promise<unknown> {
	const env = deps.env ?? process.env;
	if (!claudeSubscriptionEnabled(env))
		throw new TurnBoxPortForbidden("claude:disabled");
	const user = turn.user_id;
	const session = turn.session_id;
	switch (call.op) {
		case "runner": {
			const chat = await (deps.owner ?? agentSessionMetadataForOwner)(
				user,
				session,
			);
			if (!chat) throw new TurnBoxPortForbidden("session");
			const candidate = claudeRunnerFor({
				env,
				userId: user,
				sessionId: session,
				// The chat's own role decides, whatever the box says.
				reader: call.reader || isReaderRole(chat.agentRole ?? null),
				ySquared: call.ySquared,
			});
			if (!candidate) return null;
			if (!deps.placement) throw new TurnBoxPortForbidden("claude:placement");
			return { baseUrl: await deps.placement(turn, candidate.baseUrl) };
		}
		case "exec": {
			const box = await runnerBox(turn, call.baseUrl, env, deps);
			return (deps.machine ?? claudeRunnerMachine)(box).shell(
				call.command,
				call.timeoutMs,
			);
		}
		case "write": {
			const box = await runnerBox(turn, call.baseUrl, env, deps);
			await (deps.machine ?? claudeRunnerMachine)(box).writeFile(
				call.path,
				call.contents,
			);
			return null;
		}
		case "read": {
			const box = await runnerBox(turn, call.baseUrl, env, deps);
			return {
				contents: await (deps.machine ?? claudeRunnerMachine)(box).readFile(
					call.path,
				),
			};
		}
		case "disk": {
			const box = await runnerBox(turn, call.baseUrl, env, deps);
			return (deps.disk ?? claudeRunnerDiskShare)(box);
		}
		case "grant": {
			const secret = (
				deps.grantSecret ?? (() => gitProxyConfiguration()?.secret ?? null)
			)();
			if (!secret) throw new TurnBoxPortForbidden("claude:grant");
			return issueClaudeCodeGrant(secret, {
				userId: user,
				sessionId: session,
				turnId: turn.id,
				relay: "box",
			});
		}
		case "sessionRead":
			return (deps.sessions?.read ?? readClaudeCodeSession)(user, session);
		case "sessionSave":
			await (deps.sessions?.save ?? saveClaudeCodeSession)(
				user,
				session,
				call.record,
			);
			return null;
		case "transcriptUpload":
			return (deps.checkpoints?.upload ?? uploadCheckpoint)(
				user,
				session,
				`claude-code-${call.claudeSessionId}`,
				call.text,
			);
		case "transcriptDownload":
			return (deps.checkpoints?.download ?? downloadCheckpoint)(
				user,
				session,
				call.path,
			);
		case "subscription":
			return (deps.subscription ?? claudeSubscriptionStatus)(user);
	}
}

/**
 * The runner box a command goes to, with the edge's signing keys: one the
 * edge itself would choose. A configured runner is accepted as is; any other
 * origin only when it is the chat's pinned placement (a runner since removed
 * from the list keeps its live sessions).
 */
async function runnerBox(
	turn: ApiTurn,
	baseUrl: string,
	env: Readonly<Record<string, string | undefined>>,
	deps: TurnBoxClaudeDeps,
): Promise<ClaudeRunnerBox> {
	const configured = claudeRunnerFor({
		env,
		userId: turn.user_id,
		sessionId: turn.session_id,
		reader: false,
		ySquared: true,
	});
	if (!configured) throw new TurnBoxPortForbidden("claude:runner");
	if (!claudeRunnerUrls(env).includes(baseUrl)) {
		const pinned = deps.placement
			? await deps.placement(turn, configured.baseUrl)
			: null;
		if (pinned !== baseUrl) throw new TurnBoxPortForbidden("claude:runner");
	}
	return { ...configured, baseUrl };
}
