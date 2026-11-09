import { createHash } from "node:crypto";
import { ClaudeCodeRunFailure } from "#/domain/api-turn-failure";
import {
	CLAUDE_AGENT_SDK_CLAUDE_BINARY,
	CLAUDE_AGENT_SDK_MODULE,
	claudeAgentSdkInstallScript,
	PINNED_CLAUDE_AGENT_SDK_VERSION,
} from "#/domain/guest-cli-pin";
import { STEP_BUDGET_MS } from "#/domain/model-workflow";
import { redactSecretValues } from "#/domain/project-secret";
import { redactSecrets } from "#/domain/redact-secrets";
import { providerTimeoutError } from "../adapters/freestyle/bounded-fetch";
import { runDetachedCommand } from "../adapters/freestyle/detached-command";
import { retryTransientProviderFailure } from "../adapters/freestyle/provider-retry";
import { ResumeLater } from "../adapters/resumable-commands";
import type { ClaudeCodeShell } from "./claude-code-runner";

/** Checks the executable too: an interrupted npm install can leave only the module. */
export const CLAUDE_AGENT_SDK_READY_SCRIPT = `if [ -f ${CLAUDE_AGENT_SDK_MODULE} ] && [ -x ${CLAUDE_AGENT_SDK_CLAUDE_BINARY} ]; then
  ${CLAUDE_AGENT_SDK_CLAUDE_BINARY} --version >/dev/null
else
  exit 78
fi`;

/**
 * First-use downloads outlive a short exec connection and may span model steps.
 * The turn/version identity reattaches after resets; the install's existing flock
 * serializes concurrent users of one machine. No model is launched until ready.
 */
export async function ensureClaudeAgentSdk(input: {
	readonly shell: ClaudeCodeShell;
	readonly turnId: string;
	readonly deadline: number;
	readonly signal: AbortSignal;
	readonly redact: () => readonly string[];
	readonly sleep?: (ms: number) => Promise<void>;
}): Promise<"ready" | "pending"> {
	input.signal.throwIfAborted();
	// Only SDK probes, journaled installer launch and status reads are safe
	// here. A cold VM can return no exit status; never retry model or user work.
	const shell: ClaudeCodeShell = (command, timeout) =>
		retryTransientProviderFailure(async () => {
			input.signal.throwIfAborted();
			const result = await input.shell(command, timeout);
			if (result.exitCode === 124)
				throw providerTimeoutError("claude-sdk-setup");
			return result;
		});
	const ready = await shell(CLAUDE_AGENT_SDK_READY_SCRIPT, 30_000);
	if (ready.exitCode === 0) return "ready";
	const id = createHash("sha256")
		.update(`claude-sdk:${PINNED_CLAUDE_AGENT_SDK_VERSION}:${input.turnId}`)
		.digest("hex");
	try {
		const result = await runDetachedCommand(
			async (command) => {
				input.signal.throwIfAborted();
				return shell(command, 30_000);
			},
			id,
			["bash", "-c", claudeAgentSdkInstallScript(false)],
			{},
			STEP_BUDGET_MS,
			input.deadline,
			input.sleep,
		);
		if (result.exitCode === 0) return "ready";
		// Keep the actual diagnostic for operators, never the raw command output
		// in user-visible errors (npm can print authenticated registry URLs).
		console.warn("Claude Agent SDK installation failed", {
			exitCode: result.exitCode,
			version: PINNED_CLAUDE_AGENT_SDK_VERSION,
			detail: redactSecrets(
				redactSecretValues(
					`${result.stderr}\n${result.stdout}`,
					input.redact(),
				),
				2_000,
			),
		});
		throw new ClaudeCodeRunFailure(
			result.exitCode === 124
				? "its first-time SDK download timed out before it could start."
				: "its SDK setup failed before it could start.",
		);
	} catch (error) {
		if (error instanceof ResumeLater) return "pending";
		throw error;
	}
}
