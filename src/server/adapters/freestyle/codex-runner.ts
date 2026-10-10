import { createHash } from "node:crypto";
import { Freestyle, FreestyleApiError } from "freestyle";
import {
	ensurePinnedCodexCommand,
	PINNED_CODEX_CLI_VERSION,
} from "#/domain/guest-cli-pin";
import { WorkspaceId } from "#/domain/ids";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { checkpointForSession } from "#/server/adapters/checkpoints/records";
import { restoreSessionNativeState } from "#/server/services/session-checkpoint";
import { scopeSessionRuntimeText } from "#/server/services/session-workspace-machines";
import type {
	CodexRuntime,
	WorkspaceMachines,
} from "#/server/services/workspace-machines";
import { checkpointStorageConfigured } from "../checkpoints/storage";
import {
	CHEAP_BASE_SNAPSHOT,
	PRODUCT_IDLE_TIMEOUT_SECONDS,
} from "./product-vm";
import { GUEST_INTERNET_FIREWALL } from "./proof-vm";
import { waitUntilVmRunning } from "./wait-until-running";

const PURPOSE = "ytimesy-codex-runner";
const EXECUTOR_PORT = 8765;
const provisioning = new Map<string, Promise<CodexRuntime>>();

export async function deleteFreestyleCodexSession(
	apiKey: string,
	userId: string,
	sessionId: string,
) {
	const client = new Freestyle({ apiKey });
	const { owner, slug } = codexRunnerIdentity(userId);
	const { vms } = await client.vms.list({ slug, limit: 1 });
	const data = vms[0];
	if (!data) return;
	if (data.metadata?.purpose !== PURPOSE || data.metadata?.owner !== owner)
		throw new Error("Codex runner ownership could not be verified.");
	const vm = client.vms.ref(data.id);
	if (data.state !== "running") await vm.start();
	await waitUntilVmRunning(vm, "Codex runner cleanup");
	const root = codexRunnerRoot(sessionId);
	const result = await vm.exec({
		command: `set -eu
if [ -f ${quote(`${root}/ytimesy-codex-login.pid`)} ]; then
PID="$(cat ${quote(`${root}/ytimesy-codex-login.pid`)})"
case "$PID" in ''|*[!0-9]*) exit 1;; esac
pkill -P "$PID" 2>/dev/null || true
kill "$PID" 2>/dev/null || true
fi
sudo -n rm -rf -- ${quote(root)}`,
		timeoutMs: 15_000,
	});
	if (result.statusCode !== 0)
		throw new Error(
			"The Codex conversation could not be removed from its runner.",
		);
}

function digest(value: string) {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function codexRunnerIdentity(userId: string) {
	const owner = digest(userId);
	return { owner, slug: `ytimesy-codex-${owner}` };
}

export function codexRunnerRoot(sessionId: string) {
	return `/home/ubuntu/.ytimesy-codex/${digest(sessionId)}`;
}

export function scopeCodexRuntimeText(text: string, sessionId: string) {
	const root = codexRunnerRoot(sessionId);
	let result = scopeSessionRuntimeText(text, sessionId, root);
	for (const name of ["project-cwd", "display", "developer-instructions.txt"]) {
		result = result.replaceAll(
			`/tmp/ytimesy-${name}`,
			`${root}/ytimesy-${name}`,
		);
	}
	return result;
}

/** Only native adapter operations receive this capability; checkout tools keep the executor. */
export function codexRunnerMachines(
	base: WorkspaceMachines,
	input: {
		runnerId: WorkspaceId;
		executorId: WorkspaceId;
		sessionId: string;
		executorUrl: string;
	},
): CodexRuntime {
	const root = codexRunnerRoot(input.sessionId);
	const scope = (text: string) => scopeCodexRuntimeText(text, input.sessionId);
	const assertTarget = (id: WorkspaceId) => {
		if (id !== input.executorId && id !== input.runnerId)
			throw new Error("Codex runtime target mismatch.");
	};
	const environment = `export HOME=${quote(`${root}/home`)}
export CODEX_HOME="$HOME/.codex"
export YTIMESY_CODEX_HOME="$CODEX_HOME"
export YTIMESY_RUNTIME_ROOT=${quote(root)}
export YTIMESY_REMOTE_EXEC_URL=${quote(input.executorUrl)}
export YTIMESY_REMOTE_ENVIRONMENT_ID=${quote(input.executorId)}
export PATH="/opt/ytimesy-codex/node_modules/.bin:$PATH"
umask 077`;
	const machines: WorkspaceMachines = {
		...base,
		// Runner commands require the scoped environment and target guard in exec.
		runCapability: undefined,
		exec: (id, command, timeoutMs) => {
			assertTarget(id);
			return base.exec(
				input.runnerId,
				`${environment}\n${scope(command)}`,
				timeoutMs,
			);
		},
		readTextFile: (id, path) => {
			assertTarget(id);
			return base.readTextFile(input.runnerId, scope(path));
		},
		writeTextFile: (id, path, contents) => {
			assertTarget(id);
			return base.writeTextFile(
				input.runnerId,
				scope(path),
				path.endsWith(".py") ? scope(contents) : contents,
			);
		},
		isRunning: (id) => {
			assertTarget(id);
			return base.isRunning(input.runnerId);
		},
	};
	return { machines, workspaceId: input.runnerId, root };
}

type RuntimeInput = Parameters<
	NonNullable<WorkspaceMachines["codexRuntime"]>
>[0];

/** Slug and provider metadata recover ownership across server restarts, without credential snapshots. */
export async function resolveFreestyleCodexRuntime(
	apiKey: string,
	base: WorkspaceMachines,
	input: RuntimeInput,
): Promise<CodexRuntime | null> {
	const key = `${digest(apiKey)}:${input.userId}:${input.sessionId}`;
	if (!input.provision) return resolveRuntime(apiKey, base, input);
	const existing = provisioning.get(key);
	if (existing) return existing;
	const pending = resolveRuntime(apiKey, base, input).then((runtime) => {
		if (!runtime) throw new Error("The Codex runner was not provisioned.");
		return runtime;
	});
	provisioning.set(key, pending);
	try {
		return await pending;
	} finally {
		provisioning.delete(key);
	}
}

async function resolveRuntime(
	apiKey: string,
	base: WorkspaceMachines,
	input: RuntimeInput,
) {
	const client = new Freestyle({ apiKey });
	const { owner, slug } = codexRunnerIdentity(input.userId);
	const sourceBindingPath = "/tmp/ytimesy-codex-runner-binding.json";
	if (input.provision)
		await input.executorMachines.ensureRunning(input.executorId);
	const sourceBindingText =
		input.provision ||
		(await input.executorMachines.isRunning(input.executorId))
			? await input.executorMachines.readTextFile(
					input.executorId,
					sourceBindingPath,
				)
			: null;
	const sourceBinding = sourceBindingText
		? JSON.parse(sourceBindingText)
		: null;
	let { vms } = await client.vms.list({ slug, limit: 1 });
	const checkpoint =
		input.provision && checkpointStorageConfigured()
			? await checkpointForSession(input.userId, input.sessionId)
			: null;
	if (!vms.length && sourceBinding && !checkpoint)
		throw new Error(
			"The saved Codex runner is unavailable. Restore its conversation state before retrying; a new conversation was not created.",
		);
	if (!vms.length && input.provision) {
		try {
			await client.vms.create({
				slug,
				displayName: "ytimesy isolated Codex runner",
				snapshotId: CHEAP_BASE_SNAPSHOT,
				metadata: { purpose: PURPOSE, owner },
				firewall: GUEST_INTERNET_FIREWALL,
				idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
				maxRunSeconds: -1,
				maxRunTotalSeconds: -1,
				autoDeleteSeconds: -1,
			});
		} catch (cause) {
			if (!(cause instanceof FreestyleApiError) || cause.status !== 409)
				throw cause;
		}
		({ vms } = await client.vms.list({ slug, limit: 1 }));
	}
	const data = vms[0];
	if (!data) return null;
	if (
		data.slug !== slug ||
		data.metadata?.purpose !== PURPOSE ||
		data.metadata?.owner !== owner
	) {
		throw new Error("Codex runner ownership could not be verified.");
	}
	const runnerId = WorkspaceId(data.id);
	if (
		sourceBinding &&
		(sourceBinding.runnerId !== runnerId ||
			sourceBinding.sessionId !== input.sessionId) &&
		!(
			input.provision &&
			checkpoint?.runner_id === sourceBinding.runnerId &&
			sourceBinding.sessionId === input.sessionId
		)
	)
		throw new Error("The saved Codex runner binding does not match this chat.");
	const vm = client.vms.ref(runnerId);
	const root = codexRunnerRoot(input.sessionId);
	const bindingPath = `${root}/executor.json`;
	const domain = `ytimesy-exec-${digest(`${runnerId}:${input.executorId}`)}.internal`;
	const runtime = codexRunnerMachines(base, {
		runnerId,
		executorId: input.executorId,
		sessionId: input.sessionId,
		executorUrl: `wss://${domain}`,
	});
	if (!input.provision) {
		if (data.state !== "running") return runtime;
		const saved = await base.readTextFile(runnerId, bindingPath);
		if (!saved) return null;
		if (JSON.parse(saved).executorId !== input.executorId)
			throw new Error(
				"The Codex executor binding has changed; reconnect this chat.",
			);
		return runtime;
	}
	if (data.state !== "running") await vm.start();
	await waitUntilVmRunning(vm, "Codex runner");
	const previousBinding = await base.readTextFile(runnerId, bindingPath);
	if (
		previousBinding &&
		JSON.parse(previousBinding).executorId !== input.executorId &&
		checkpoint?.executor_id !== JSON.parse(previousBinding).executorId
	)
		throw new Error(
			"This conversation's executor changed. Restore the original workspace before continuing.",
		);
	await checked(
		base,
		runnerId,
		`set -eu
sudo mkdir -p /opt/ytimesy-codex
sudo chown "$(id -un):$(id -gn)" /opt/ytimesy-codex
exec 9>/opt/ytimesy-codex/install.lock
flock -x 9
if [ "$(/opt/ytimesy-codex/node_modules/.bin/codex --version 2>/dev/null || true)" != "codex-cli ${PINNED_CODEX_CLI_VERSION}" ]; then
  npm install --prefix /opt/ytimesy-codex @openai/codex@${PINNED_CODEX_CLI_VERSION}
fi
umask 077
mkdir -p ${quote(`${root}/home/.codex`)}
chmod 700 ${quote(root)}`,
		240_000,
	);
	await startExecutor(input.executorMachines, input.executorId);
	const { rules } = await client.tls.rules.list({ vmId: runnerId });
	const rule = rules.find((rule) => rule.domain === domain);
	if (rule) {
		if (
			rule.source.vmId !== runnerId ||
			rule.destination.vmId !== input.executorId ||
			rule.destination.port !== EXECUTOR_PORT
		) {
			throw new Error(
				"The executor network rule has an unexpected owner or destination.",
			);
		}
	} else {
		try {
			await client.tls.rules.create({
				action: "allow",
				domain,
				source: { vmId: runnerId },
				destination: { vmId: input.executorId, port: EXECUTOR_PORT },
			});
		} catch (cause) {
			if (!(cause instanceof FreestyleApiError) || cause.status !== 409)
				throw cause;
			const { rules: concurrentRules } = await client.tls.rules.list({
				vmId: runnerId,
			});
			const concurrentRule = concurrentRules.find(
				(candidate) => candidate.domain === domain,
			);
			if (
				!concurrentRule ||
				concurrentRule.source.vmId !== runnerId ||
				concurrentRule.destination.vmId !== input.executorId ||
				concurrentRule.destination.port !== EXECUTOR_PORT
			)
				throw new Error(
					"The concurrent executor network rule could not be verified.",
				);
		}
	}
	for (const name of ["project-cwd", "display", "developer-instructions.txt"]) {
		const text = await input.executorMachines.readTextFile(
			input.executorId,
			`/tmp/ytimesy-${name}`,
		);
		if (text)
			await base.writeTextFile(runnerId, `${root}/ytimesy-${name}`, text);
	}
	const cwd = await base.readTextFile(runnerId, `${root}/ytimesy-project-cwd`);
	if (!cwd?.trim().startsWith("/") || cwd.trim().includes("\n"))
		throw new Error(
			"The workspace checkout is not ready for remote execution.",
		);
	if (!previousBinding && checkpoint?.runner_id) {
		await restoreSessionNativeState(
			base,
			input.userId,
			input.sessionId,
			runnerId,
			root,
		);
	} else if (!previousBinding)
		await migrateCodexHistory(
			input.executorMachines,
			runtime.machines,
			input.executorId,
			root,
		);
	await base.writeTextFile(
		runnerId,
		bindingPath,
		JSON.stringify({ executorId: input.executorId }),
	);
	await input.executorMachines.writeTextFile(
		input.executorId,
		sourceBindingPath,
		JSON.stringify({ runnerId, sessionId: input.sessionId }),
	);
	return runtime;
}

async function checked(
	machines: WorkspaceMachines,
	id: WorkspaceId,
	command: string,
	timeoutMs = 30_000,
) {
	const result = await machines.exec(id, command, timeoutMs);
	if (result.exitCode !== 0)
		throw new Error(
			`Codex runner preparation failed: ${(result.stderr || result.stdout).slice(-500)}`,
		);
	return result.stdout;
}

async function startExecutor(machines: WorkspaceMachines, id: WorkspaceId) {
	await checked(
		machines,
		id,
		`set -eu
exec 9>/tmp/ytimesy-codex-executor-start.lock
flock -x 9
${ensurePinnedCodexCommand()}
export PATH="$HOME/.local/bin:$HOME/.codex/bin:$HOME/.codex/packages/standalone/current:$PATH"
if [ -f /tmp/ytimesy-codex-executor.pid ] && kill -0 "$(cat /tmp/ytimesy-codex-executor.pid)" 2>/dev/null; then exit 0; fi
umask 077
nohup codex exec-server --listen ws://0.0.0.0:${EXECUTOR_PORT} 9>&- > /tmp/ytimesy-codex-executor.log 2>&1 < /dev/null &
echo $! > /tmp/ytimesy-codex-executor.pid
python3 -c 'import socket,time
for attempt in range(50):
 try:
  socket.create_connection(("127.0.0.1",${EXECUTOR_PORT}),.2).close(); break
 except OSError: time.sleep(.1)
else: raise RuntimeError("Executor did not start")'`,
		240_000,
	);
}

/** Copies only this conversation's rollouts; credentials and sibling conversations stay behind. */
async function migrateCodexHistory(
	source: WorkspaceMachines,
	target: WorkspaceMachines,
	id: WorkspaceId,
	root: string,
) {
	const saved = await source.readTextFile(
		id,
		"/tmp/ytimesy-codex-thread-state.json",
	);
	if (!saved) return;
	const state = JSON.parse(saved);
	if (state.turnStatus === "running" || state.sideTurnStatus === "running")
		throw new Error(
			"Wait for the active Codex turn to finish before moving this chat to the runner.",
		);
	const ids = [state.threadId, state.sideThreadId].filter(
		(value): value is string =>
			typeof value === "string" && /^[a-zA-Z0-9-]+$/.test(value),
	);
	const exportScript = `import os,json,pathlib
home=pathlib.Path(os.environ['HOME'])/'.codex'
ids=json.loads(${JSON.stringify(JSON.stringify(ids))})
files={}
for folder in ['sessions','archived_sessions']:
 for path in (home/folder).rglob('*.jsonl'):
  if any(thread in path.name for thread in ids): files[str(path.relative_to(home))]=path.read_text()
result=json.dumps(files)
if len(result)>16000000: raise RuntimeError('Conversation history exceeds migration limit')
print(result)`;
	const files = JSON.parse(
		await checked(source, id, `python3 -c ${quote(exportScript)}`),
	) as Record<string, string>;
	for (const thread of ids) {
		if (!Object.keys(files).some((path) => path.includes(thread)))
			throw new Error(
				"The saved Codex thread history is missing; migration stopped without changing the conversation.",
			);
	}
	for (const [path, contents] of Object.entries(files)) {
		if (
			!/^(sessions|archived_sessions)\/[a-zA-Z0-9_./-]+\.jsonl$/.test(path) ||
			path.includes("..")
		)
			throw new Error("Invalid Codex history path.");
		const destination = `${root}/home/.codex/${path}`;
		await checked(
			target,
			id,
			`mkdir -p ${quote(destination.slice(0, destination.lastIndexOf("/")))}`,
		);
		await target.writeTextFile(id, destination, contents);
	}
	await target.writeTextFile(id, "/tmp/ytimesy-codex-thread-state.json", saved);
	await checked(
		source,
		id,
		`if [ -f /tmp/ytimesy-codex-login.pid ]; then
PID="$(cat /tmp/ytimesy-codex-login.pid)"
pkill -P "$PID" 2>/dev/null || true
kill "$PID" 2>/dev/null || true
rm -f /tmp/ytimesy-codex-login.pid
fi`,
	);
}
