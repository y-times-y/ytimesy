import { randomUUID } from "node:crypto";
import { agentSessionMachineSlug } from "#/domain/agent-session";
import {
	PINNED_CODEX_CLI_VERSION,
	pinnedCodexInstallCommand,
} from "#/domain/guest-cli-pin";
import type {
	EvaluationProtocol,
	EvaluationTask,
} from "#/domain/harness-evaluation";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { saveAgentSessionProviderRef } from "#/server/adapters/agent-sessions";
import { database } from "#/server/adapters/database";
import {
	codexAccessTokenExpiresAt,
	codexExternalTokens,
} from "#/server/auth/codex-managed-auth";
import { unseal } from "#/server/auth/token-vault";
import {
	deleteAgentSessionMachine,
	openAgentSession,
} from "#/server/services/agent-session-machine";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import { evaluationPatchScript } from "./production";

/** Native harness control on a disposable copy of the same clean environment. */
export async function runNativeCodexEvaluation(input: {
	machines: WorkspaceMachines;
	userId: string;
	snapshotId: string;
	task: EvaluationTask;
	protocol: EvaluationProtocol;
	signal?: AbortSignal;
}) {
	const { machines, task, protocol } = input;
	input.signal?.throwIfAborted();
	// Native controls still need an owned admission identity; proof VMs cannot
	// pass the product mutation boundary when infrastructure budgets are enabled.
	const control = await openAgentSession({
		userId: input.userId,
		projectId: task.projectId,
		harness: "codex",
		title: `Native evaluation ${task.id}`,
	});
	const root = `/home/ubuntu/.ytimesy-native-evaluation-${randomUUID()}`;
	try {
		const vm = {
			workspaceId: await machines.provisionSession(
				agentSessionMachineSlug(control.id),
				input.snapshotId,
			),
		};
		await saveAgentSessionProviderRef(control.id, vm.workspaceId);
		const setup = await machines.exec(
			vm.workspaceId,
			`set -eu
export PATH="$HOME/.local/bin:$PATH"
if [ "$(codex --version 2>/dev/null || true)" != 'codex-cli ${PINNED_CODEX_CLI_VERSION}' ]; then
${pinnedCodexInstallCommand()}
fi
mkdir -m 700 ${quote(root)}
cd "$(cat /tmp/ytimesy-project-cwd)"
git rev-parse HEAD
git status --porcelain`,
			120000,
		);
		if (
			setup.exitCode ||
			setup.stdout.trim().split("\n").at(-1) !== task.commit
		)
			throw new Error(
				"Native control checkout differs from the pinned clean commit.",
			);
		const tokens = await codexExternalTokens(input.userId);
		const stored = await database().query<{ encrypted_codex_auth: string }>(
			"select encrypted_codex_auth from agent_account where user_id=$1 and provider='codex' and status='connected'",
			[input.userId],
		);
		const identity = JSON.parse(
			await unseal(stored.rows[0].encrypted_codex_auth),
		);
		if (typeof identity.tokens?.id_token !== "string")
			throw new Error(
				"Native subscription control needs its existing identity token.",
			);
		if (
			codexAccessTokenExpiresAt({
				...identity,
				tokens: { ...identity.tokens, access_token: tokens.accessToken },
			}) <
			Date.now() + (protocol.limits.durationSeconds + 60) * 1000
		)
			throw new Error(
				"Native control access credential will expire before its deadline; reconnect before testing.",
			);
		// Pin the production subscription transport instead of the CLI's separate workspace-routing login.
		await machines.writeTextFile(
			vm.workspaceId,
			`${root}/auth.json`,
			JSON.stringify({
				auth_mode: "chatgpt",
				tokens: {
					access_token: tokens.accessToken,
					id_token: identity.tokens.id_token,
					refresh_token: "",
					account_id: tokens.chatgptAccountId,
				},
			}),
		);
		await machines.writeTextFile(
			vm.workspaceId,
			`${root}/config.toml`,
			[
				'model_provider = "evaluation_subscription"',
				"[model_providers.evaluation_subscription]",
				'name = "Existing Codex subscription"',
				'base_url = "https://chatgpt.com/backend-api/codex"',
				'env_key = "YTIMESY_SUBSCRIPTION_ACCESS_TOKEN"',
				'wire_api = "responses"',
				"requires_openai_auth = false",
				"supports_websockets = false",
				`http_headers = { "ChatGPT-Account-ID" = ${JSON.stringify(tokens.chatgptAccountId)} }`,
			].join("\n"),
		);
		await machines.writeTextFile(
			vm.workspaceId,
			`${root}/prompt.txt`,
			task.prompt,
		);
		const started = Date.now();
		const launch = await machines.exec(
			vm.workspaceId,
			`set -eu
export HOME=/home/ubuntu
export PATH="$HOME/.local/bin:$PATH"
export CODEX_HOME=${quote(root)}
unset OPENAI_API_KEY ANTHROPIC_API_KEY
export YTIMESY_SUBSCRIPTION_ACCESS_TOKEN="$(python3 -c 'import json,os; print(json.load(open(os.environ["CODEX_HOME"]+"/auth.json"))["tokens"]["access_token"])')"
chmod 600 "$CODEX_HOME/auth.json"
cd "$(cat /tmp/ytimesy-project-cwd)"
nohup sh -c ${quote(`timeout --signal=TERM --kill-after=5s ${protocol.limits.durationSeconds}s codex exec --json --color never --model ${quote(protocol.modelId)} -c ${quote(`model_reasoning_effort="${protocol.reasoning}"`)} --sandbox workspace-write - < ${quote(`${root}/prompt.txt`)} > ${quote(`${root}/events.jsonl`)} 2> ${quote(`${root}/stderr`)}; result=$?; printf '%s' "$result" > ${quote(`${root}/exit-code`)}`)} < /dev/null > /dev/null 2>&1 &
`,
			15000,
		);
		if (launch.exitCode) throw new Error("Native control did not start.");
		let exitCode: number | undefined;
		const deadline = started + (protocol.limits.durationSeconds + 30) * 1000;
		while (Date.now() < deadline) {
			input.signal?.throwIfAborted();
			const status = await machines.exec(
				vm.workspaceId,
				`if [ -f ${quote(`${root}/exit-code`)} ]; then cat ${quote(`${root}/exit-code`)}; fi`,
				15000,
			);
			if (status.exitCode)
				throw new Error("Native control status is unavailable.");
			if (/^\d+$/.test(status.stdout.trim())) {
				exitCode = Number(status.stdout.trim());
				break;
			}
			await new Promise((done) => setTimeout(done, 1000));
		}
		if (exitCode === undefined)
			throw new Error("Native control exceeded its deadline.");
		const events =
			(await machines.readTextFile(vm.workspaceId, `${root}/events.jsonl`)) ??
			"";
		const stderr =
			(await machines.readTextFile(vm.workspaceId, `${root}/stderr`)) ?? "";
		const output = await machines.exec(
			vm.workspaceId,
			evaluationPatchScript(task.commit),
			30000,
		);
		if (output.exitCode) throw new Error("Native patch export failed.");
		return {
			exitCode,
			events,
			stderr,
			patches: [output.stdout],
			durationMs: Date.now() - started,
			cliVersion: PINNED_CODEX_CLI_VERSION,
			vmId: vm.workspaceId,
			requestLimitEnforced: false,
			tokenLimitEnforced: false,
		};
	} finally {
		// Destroy the exact disposable VM, never the user runner or template.
		await deleteAgentSessionMachine(machines, {
			userId: input.userId,
			projectId: task.projectId,
			sessionId: control.id,
		});
	}
}
