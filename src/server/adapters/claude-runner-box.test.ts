import { describe, expect, it } from "vitest";
import { runnerSignature } from "../../../infra/claude-runner-box/server.mjs";
import {
	claudeRunnerMachine,
	runnerRequestSignature,
} from "./claude-runner-box";

const box = { baseUrl: "https://runner-1.example.com", secret: "s".repeat(40) };

describe("claudeRunnerMachine", () => {
	it("signs what the box verifies", async () => {
		const args = [
			"POST",
			"/exec",
			"1794271231860",
			"a".repeat(32),
			'{"command":"true"}',
		] as const;
		expect(await runnerRequestSignature(box.secret, ...args)).toBe(
			runnerSignature(box.secret, ...args),
		);
	});

	it("sends signed requests and returns the box's answers", async () => {
		const seen: {
			url: string;
			headers: Record<string, string>;
			body: string;
		}[] = [];
		const fetcher = (async (url: URL, init: RequestInit) => {
			seen.push({
				url: String(url),
				headers: init.headers as Record<string, string>,
				body: String(init.body),
			});
			const answer =
				url.pathname === "/exec"
					? { exitCode: 0, stdout: "ok", stderr: "" }
					: url.pathname === "/read"
						? { contents: "text" }
						: { ok: true };
			return new Response(JSON.stringify(answer));
		}) as unknown as typeof fetch;
		const machine = claudeRunnerMachine(box, fetcher);
		expect(await machine.shell("echo ok", 5000)).toEqual({
			exitCode: 0,
			stdout: "ok",
			stderr: "",
		});
		await machine.writeFile("runs/a", "x");
		expect(await machine.readFile("runs/a")).toBe("text");
		expect(seen.map((call) => call.url)).toEqual([
			"https://runner-1.example.com/exec",
			"https://runner-1.example.com/write",
			"https://runner-1.example.com/read",
		]);
		for (const call of seen) {
			expect(call.headers["x-ytimesy-delivery-signature"]).toMatch(
				/^[0-9a-f]{64}$/,
			);
			expect(call.headers["x-ytimesy-runner-nonce"]).toMatch(/^[0-9a-f]{32}$/);
		}
	});

	it("reads a missing file as null and fails a refused command", async () => {
		const refuse = (async () =>
			new Response("{}", { status: 403 })) as unknown as typeof fetch;
		const machine = claudeRunnerMachine(box, refuse);
		expect(await machine.readFile("nope")).toBeNull();
		await expect(machine.shell("true", 1000)).rejects.toThrow("403");
	});
});
