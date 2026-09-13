import { Effect } from "effect";
import type { WorkspaceId } from "#/domain/ids";
import type { CodexProbeResult } from "#/server/services/capabilities";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import { CODEX_JSONRPC_PROBE_SCRIPT } from "./json-rpc-probe";
import { agentConnectionFromProbe, parseCodexProbeReport } from "./protocol";

const CODEX_INSTALL_SCRIPT = `set -eu
export HOME="\${HOME:-/root}"
curl -fsSL https://chatgpt.com/codex/install.sh | sh
export PATH="$HOME/.local/bin:$HOME/.codex/bin:$HOME/.codex/packages/standalone/current:$PATH"
if [ -x "$HOME/.codex/packages/standalone/current/codex" ]; then
  CODEX_BIN="$HOME/.codex/packages/standalone/current/codex"
elif command -v codex >/dev/null 2>&1; then
  CODEX_BIN="$(command -v codex)"
else
  echo "codex binary not found after install" >&2
  exit 1
fi
echo "CODEX_BIN=$CODEX_BIN"
"$CODEX_BIN" --version
`;

function firstMatch(stdout: string, pattern: RegExp): string | null {
	return stdout.match(pattern)?.[1]?.trim() ?? null;
}

export function installAndProbeDeviceCode(
	machines: WorkspaceMachines,
	workspaceId: WorkspaceId,
): Effect.Effect<CodexProbeResult> {
	return Effect.gen(function* () {
		const install = yield* Effect.tryPromise(() =>
			machines.exec(workspaceId, CODEX_INSTALL_SCRIPT, 240_000),
		);
		if (install.exitCode !== 0) {
			return {
				connection: {
					status: "failed" as const,
					message: `Codex install failed: ${(install.stderr || install.stdout).trim()}`,
				},
				codexVersion: null,
				notes: ["Official install.sh did not produce a working Codex binary."],
			};
		}

		const codexBin = firstMatch(install.stdout, /^CODEX_BIN=(.+)$/m);
		const codexVersion =
			firstMatch(install.stdout, /codex-cli\s+(\S+)/i) ??
			install.stdout
				.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0 && !line.startsWith("CODEX_BIN=")) ??
			null;

		if (!codexBin) {
			return {
				connection: {
					status: "failed" as const,
					message: "Codex install succeeded without reporting a binary path",
				},
				codexVersion,
				notes: [install.stdout.trim()],
			};
		}

		yield* Effect.tryPromise(() =>
			machines.writeTextFile(
				workspaceId,
				"/tmp/ytimesy-codex-probe.py",
				CODEX_JSONRPC_PROBE_SCRIPT,
			),
		);

		const probe = yield* Effect.tryPromise(() =>
			machines.exec(
				workspaceId,
				`CODEX_BIN=${shellSingleQuote(codexBin)} CODEX_VERSION=${shellSingleQuote(codexVersion ?? "")} python3 /tmp/ytimesy-codex-probe.py`,
				120_000,
			),
		);

		const report = parseCodexProbeReport(probe.stdout + probe.stderr);
		const notes = [
			...(report.notes ?? []),
			probe.exitCode === 0
				? "Probe process exited 0."
				: `Probe process exited ${probe.exitCode}.`,
		];
		if (!report.ok && probe.stderr.trim()) {
			notes.push(probe.stderr.trim());
		}

		return {
			connection: agentConnectionFromProbe(report),
			codexVersion: report.codexVersion ?? codexVersion,
			notes,
		};
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.succeed({
				connection: {
					status: "failed" as const,
					message: cause instanceof Error ? cause.message : String(cause),
				},
				codexVersion: null,
				notes: [
					"Workspace command failed before a Codex protocol result was available.",
				],
			} satisfies CodexProbeResult),
		),
	);
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
