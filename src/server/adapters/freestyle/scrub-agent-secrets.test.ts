import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SCRUB_MEMORY_CREDENTIAL } from "#/domain/memory-repo";
import {
	AGENT_SECRETS_DIRECTORY,
	SCRUB_AGENT_SECRETS,
} from "#/domain/project-secret";
import {
	SCRUB_WORKSPACE_SECRETS,
	scrubAgentSecrets,
} from "./scrub-agent-secrets";

describe("scrubAgentSecrets", () => {
	it("deletes the env directory and the memory token and checks both are gone", async () => {
		const exec = vi.fn(async () => ({ statusCode: 0 }));
		await scrubAgentSecrets({ exec } as never);
		expect(exec).toHaveBeenCalledWith({
			command: SCRUB_WORKSPACE_SECRETS,
			timeoutMs: 15_000,
		});
		expect(SCRUB_WORKSPACE_SECRETS).toContain(SCRUB_AGENT_SECRETS);
		expect(SCRUB_WORKSPACE_SECRETS).toContain(SCRUB_MEMORY_CREDENTIAL);
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

	it("removes the memory clone's token header and passes without a clone", () => {
		const home = mkdtempSync(join(tmpdir(), "ytimesy-scrub-home-"));
		try {
			const run = () =>
				spawnSync("sh", ["-c", SCRUB_MEMORY_CREDENTIAL], {
					env: { ...process.env, HOME: home },
				}).status;
			expect(run()).toBe(0);
			const memory = join(home, "memory");
			execFileSync("git", ["init", "-q", memory]);
			execFileSync("git", [
				"-C",
				memory,
				"config",
				"http.https://artifacts.example/u/memory.git.extraHeader",
				"Authorization: Bearer art_secret_token",
			]);
			execFileSync("git", ["-C", memory, "config", "user.name", "memory"]);
			expect(run()).toBe(0);
			const config = readFileSync(join(memory, ".git/config"), "utf8");
			expect(config).not.toContain("art_secret_token");
			expect(config).toContain("name = memory");
		} finally {
			rmSync(home, { recursive: true });
		}
	});
});
