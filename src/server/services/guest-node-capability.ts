import { createHash } from "node:crypto";
import type { z } from "zod";
import { publicToolDetail } from "#/domain/tool-detail";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

const packages = {
	debugger: ["vscode-jsonrpc@9.0.3"],
	browser: ["playwright-core@1.63.0"],
	language: [
		"vscode-jsonrpc@9.0.3",
		"typescript-language-server@6.0.1",
		"typescript@6.0.2",
	],
} as const;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Installs pinned, script-free tooling outside the repo, on demand, in the guest only. */
export function guestCapabilityCommand(
	capability: keyof typeof packages,
	source: string,
	arguments_: unknown,
	options: { onlyInstalled?: boolean } = {},
) {
	const dependencies = packages[capability];
	const digest = createHash("sha256")
		.update(JSON.stringify(dependencies))
		.digest("hex")
		.slice(0, 16);
	const directory = `/tmp/ytimesy-capability-${capability}-${digest}`;
	if (options.onlyInstalled)
		return `if test -f ${quote(`${directory}/ready`)}; then timeout --kill-after=5s 55s node --input-type=module -e ${quote(source)} ${quote(directory)} ${quote(JSON.stringify(arguments_))}; else printf '%s\\n' '{"available":false}'; fi`;
	return `set -eu
mkdir -p ${quote(directory)}
(
flock -w 120 9
if ! test -f ${quote(`${directory}/ready`)}; then
  timeout --kill-after=5s 110s npm install --prefix ${quote(directory)} --ignore-scripts --no-audit --no-fund --package-lock=false ${dependencies.map(quote).join(" ")} >&2
  touch ${quote(`${directory}/ready`)}
fi
) 9>${quote(`${directory}/install.lock`)}
timeout --kill-after=5s 55s node --input-type=module -e ${quote(source)} ${quote(directory)} ${quote(JSON.stringify(arguments_))}`;
}

export async function runGuestCapability<T>(
	workspace: AgentToolWorkspace,
	capability: keyof typeof packages,
	source: string,
	arguments_: unknown,
	resultSchema: z.ZodType<T>,
	signal: AbortSignal,
	options: { onlyInstalled?: boolean } = {},
): Promise<T> {
	signal.throwIfAborted();
	const result = await workspace.machines.exec(
		workspace.vm,
		guestCapabilityCommand(capability, source, arguments_, options),
		180_000,
	);
	signal.throwIfAborted();
	if (result.exitCode)
		throw new Error(
			`Guest ${capability} capability failed (exit ${result.exitCode}). No project files were changed. ${publicToolDetail(result.stderr).slice(-1200) || "Check that Node/npm and the requested server or browser are available."}`,
		);
	if (result.stdout.length > 256_000)
		throw new Error("Guest capability output exceeded its safety limit.");
	return resultSchema.parse(JSON.parse(result.stdout));
}
