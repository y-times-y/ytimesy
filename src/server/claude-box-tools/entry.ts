import { readFile, rm } from "node:fs/promises";
import { Freestyle } from "freestyle";
import {
	type ClaudeBoxToolsConfig,
	type ClaudeBoxToolsServer,
	startClaudeBoxTools,
} from "./server";

/**
 * The module the run's runner.mjs imports on the Claude runner box (bundled by
 * scripts/build-claude-box-tools.ts, written to the box by the edge). Reads
 * the run's grant file and deletes it at once, so the identity token lives
 * only in this process from then on, and starts the tool server.
 */
export async function startBoxTools(input: {
	readonly configPath: string;
	readonly edge: { url: string; headers: Record<string, string> };
}): Promise<ClaudeBoxToolsServer> {
	let config: ClaudeBoxToolsConfig;
	try {
		config = JSON.parse(await readFile(input.configPath, "utf8"));
	} finally {
		await rm(input.configPath, { force: true });
	}
	const vm = new Freestyle({ identityAccessToken: config.token }).vms
		.ref(config.vmId)
		.linuxUser(config.linuxUser);
	return startClaudeBoxTools({
		config,
		edge: input.edge,
		exec: (options) => vm.exec(options),
	});
}
