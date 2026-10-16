import { describe, expect, it, vi } from "vitest";
import {
	AGENT_SECRETS_DIRECTORY,
	SCRUB_AGENT_SECRETS,
} from "#/domain/project-secret";
import { scrubAgentSecrets } from "./scrub-agent-secrets";

describe("scrubAgentSecrets", () => {
	it("deletes the env directory and checks it is gone", async () => {
		const exec = vi.fn(async () => ({ statusCode: 0 }));
		await scrubAgentSecrets({ exec } as never);
		expect(exec).toHaveBeenCalledWith({
			command: SCRUB_AGENT_SECRETS,
			timeoutMs: 15_000,
		});
		expect(SCRUB_AGENT_SECRETS).toBe(
			`rm -rf ${AGENT_SECRETS_DIRECTORY} && test ! -e ${AGENT_SECRETS_DIRECTORY}`,
		);
	});

	it("refuses the snapshot when removal is not proven", async () => {
		for (const statusCode of [1, undefined]) {
			const exec = vi.fn(async () => ({ statusCode }));
			await expect(scrubAgentSecrets({ exec } as never)).rejects.toThrow(
				"the snapshot was not taken",
			);
		}
	});
});
