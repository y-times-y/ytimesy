import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import {
	environmentDiagnosisPrompt,
	validatedEnvironmentDiagnosis,
} from "#/domain/environment-diagnosis";
import { WorkspaceId } from "#/domain/ids";
import {
	codexExternalTokens,
	hasManagedCodexAuth,
} from "../../auth/codex-managed-auth";
import { createFreestyleWorkspaceMachines } from "../freestyle/workspace-machines";
import type { RuntimeCommandResult } from "../workspace-runtime";
import { REMOVE_CODEX_CREDENTIAL_FILES } from "./credential-files";
import {
	configureCodexExternalAuth,
	readLoginStatus,
	stopCodexLoginDaemon,
	submitCodexTask,
} from "./login-session";

/** Diagnose only. The service validates a small repair capability, never model-written shell. */
export async function diagnoseEnvironmentFailure(input: {
	userId: string;
	modelId: string;
	vm: string;
	directory: string;
	failure: RuntimeCommandResult;
	secrets: Record<string, string>;
}) {
	if (!(await hasManagedCodexAuth(input.userId)))
		throw new Error(
			"Connect Codex to diagnose setup automatically, or fix the install command and retry. No API fallback was used.",
		);
	const key = process.env.FREESTYLE_API_KEY;
	if (!key) throw new Error("Environment repair runtime is unavailable.");
	const machines = createFreestyleWorkspaceMachines(key);
	const vm = WorkspaceId(input.vm);
	try {
		await machines.writeTextFile(
			vm,
			"/tmp/ytimesy-project-cwd",
			`${input.directory}\n`,
		);
		const status = await Effect.runPromise(
			configureCodexExternalAuth(
				machines,
				vm,
				await codexExternalTokens(input.userId),
				{ diagnosisOnly: true },
			),
		);
		if (
			status.stage !== "authenticated" ||
			!status.models.some((model) => model.id === input.modelId)
		)
			throw new Error(
				"Codex setup diagnosis is unavailable. Check subscription access and retry; no API fallback was used.",
			);
		const previousTurn = status.turn;
		await Effect.runPromise(
			submitCodexTask(machines, vm, {
				modelId: input.modelId,
				readOnly: true,
				text: environmentDiagnosisPrompt(input.failure, input.secrets),
			}),
		);
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			await delay(2_000);
			const current = await Effect.runPromise(readLoginStatus(machines, vm));
			if (current.stage !== "authenticated")
				throw new Error(
					"Setup diagnosis lost its connection. Retry after reconnecting Codex.",
				);
			if (
				current.turn &&
				JSON.stringify(current.turn) !== JSON.stringify(previousTurn) &&
				current.turnStatus !== "running"
			) {
				if (current.turn.status !== "completed" || !current.turn.text)
					throw new Error(
						"Setup diagnosis did not complete. Check Codex access and retry.",
					);
				return validatedEnvironmentDiagnosis(current.turn.text);
			}
		}
		throw new Error("Setup diagnosis timed out. No repair was executed.");
	} finally {
		await Effect.runPromise(stopCodexLoginDaemon(machines, vm));
		const cleaned = await machines.exec(
			vm,
			`${REMOVE_CODEX_CREDENTIAL_FILES}\nif [ -f /tmp/ytimesy-codex-login.pid ]; then exit 1; fi`,
			15_000,
		);
		assertDiagnosisCleaned(cleaned.exitCode);
	}
}

function assertDiagnosisCleaned(exitCode: number) {
	if (exitCode !== 0)
		throw new Error(
			"Could not clean up setup diagnosis credentials; environment activation is blocked.",
		);
}
