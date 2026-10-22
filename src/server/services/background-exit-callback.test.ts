import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_EXIT_TOKEN_HEADER,
	verifyBackgroundExitToken,
} from "#/domain/background-exit-wake";
import { WorkspaceId } from "#/domain/ids";
import {
	BACKGROUND_EXIT_USER_AGENT,
	prepareBackgroundExitCallback,
} from "./background-exit-callback";

const run = promisify(execFile);
const secret = "k".repeat(48);
const cleanup: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

/** Runs guest commands and file writes on this machine, as the VM would. */
const hostMachines = () => ({
	exec: vi.fn(async (_vm: unknown, command: string) => {
		try {
			const output = await run("bash", ["-c", command]);
			return { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
		} catch (error) {
			const failed = error as { code: number; stdout: string; stderr: string };
			return {
				exitCode: failed.code,
				stdout: failed.stdout,
				stderr: failed.stderr,
			};
		}
	}),
	writeTextFile: vi.fn(async (_vm: unknown, path: string, contents: string) =>
		writeFile(path, contents),
	),
});

describe("a background command's exit callback", () => {
	it("is skipped (the cron still wakes the chat) when no edge origin is configured", async () => {
		vi.stubEnv("YTIMESY_GIT_PROXY_URL", "");
		const machines = hostMachines();
		expect(
			await prepareBackgroundExitCallback(machines, WorkspaceId("vm"), {
				userId: "user",
				sessionId: crypto.randomUUID(),
				commandId: crypto.randomUUID(),
				root: "/nonexistent",
			}),
		).toBe("");
		expect(machines.exec).not.toHaveBeenCalled();
	});

	it("keeps its token out of argv, in a private directory, and posts it within a second of the exit", async () => {
		vi.stubEnv("YTIMESY_GIT_PROXY_URL", "https://edge.example");
		vi.stubEnv("YTIMESY_GIT_PROXY_SECRET", secret);
		const root = await mkdtemp(join(tmpdir(), "ytimesy-exit-"));
		cleanup.push(root);
		const request = {
			userId: "user",
			sessionId: crypto.randomUUID(),
			commandId: crypto.randomUUID(),
		};
		const machines = hostMachines();
		const suffix = await prepareBackgroundExitCallback(
			machines,
			WorkspaceId("vm"),
			{ ...request, root },
		);
		const directory = `${root}/${request.commandId}.exit`;
		expect(suffix).toContain(directory);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		const stored = JSON.parse(
			await readFile(`${directory}/request.json`, "utf8"),
		) as { url: string; body: string; token: string };
		expect(stored.url).toBe("https://edge.example/background-exit");
		expect(JSON.parse(stored.body)).toEqual(request);
		expect(await verifyBackgroundExitToken(secret, request, stored.token)).toBe(
			true,
		);
		// No shell the guest runs carries the token.
		for (const call of machines.exec.mock.calls)
			expect(call[1]).not.toContain(stored.token);
		expect(suffix).not.toContain(stored.token);

		// The guest posts to the edge right after the command's status is written.
		const received: { headers: Record<string, unknown>; body: string }[] = [];
		const server = createServer((incoming, response) => {
			let body = "";
			incoming.on("data", (chunk) => {
				body += chunk;
			});
			incoming.on("end", () => {
				received.push({ headers: incoming.headers, body });
				response.writeHead(202).end();
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const { port } = server.address() as { port: number };
			await writeFile(
				`${directory}/request.json`,
				JSON.stringify({
					...stored,
					url: `http://127.0.0.1:${port}/background-exit`,
				}),
			);
			const started = Date.now();
			await run("bash", ["-c", `printf '0\\n' >${root}/status${suffix}`]);
			expect(Date.now() - started).toBeLessThan(1_000);
		} finally {
			server.close();
		}
		expect(received).toHaveLength(1);
		expect(received[0].headers[BACKGROUND_EXIT_TOKEN_HEADER]).toBe(
			stored.token,
		);
		// Cloudflare refuses urllib's default User-Agent (error 1010).
		expect(received[0].headers["user-agent"]).toBe(BACKGROUND_EXIT_USER_AGENT);
		expect(JSON.parse(received[0].body)).toEqual(request);
		// Used once, then deleted.
		await expect(stat(directory)).rejects.toThrow();
	});
});
