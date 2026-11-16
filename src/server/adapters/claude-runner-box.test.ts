import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	runnerSignature,
	runnerSignedMaterial,
} from "../../../infra/claude-runner-box/server.mjs";
import {
	claudeRunnerDiskShare,
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

	it("sends both signatures while the shared key is still set, and the Ed25519 one verifies", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const signingKey = privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64");
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" })),
		);
		await claudeRunnerMachine({ ...box, signingKey }, fetcher).shell(
			"true",
			1000,
		);
		const init = fetcher.mock.calls[0]?.[1];
		const headers = init?.headers as Record<string, string>;
		expect(headers["x-ytimesy-delivery-signature"]).toMatch(/^[0-9a-f]{64}$/);
		const material = runnerSignedMaterial(
			"POST",
			"/exec",
			headers["x-ytimesy-delivery-expires"],
			headers["x-ytimesy-runner-nonce"],
			String(init?.body),
		);
		expect(
			verify(
				null,
				Buffer.from(material),
				publicKey,
				Buffer.from(headers["x-ytimesy-runner-signature-ed25519"], "base64url"),
			),
		).toBe(true);
	});

	it("refuses to send with a malformed Ed25519 key instead of retrying it as a network failure", async () => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			claudeRunnerMachine(
				{ baseUrl: box.baseUrl, signingKey: "A".repeat(64) },
				fetcher,
			).readFile("x"),
		).rejects.toThrow(/YTIMESY_CLAUDE_RUNNER_SIGNING_KEY/);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("does not hide refused reads or replay refused commands", async () => {
		const refuse = (async () =>
			new Response("{}", { status: 403 })) as unknown as typeof fetch;
		const machine = claudeRunnerMachine(box, refuse);
		await expect(machine.readFile("nope")).rejects.toMatchObject({
			operation: "read",
			httpStatus: 403,
		});
		await expect(machine.shell("true", 1000)).rejects.toMatchObject({
			operation: "exec",
			httpStatus: 403,
		});
	});
});

it("retries only observations with fresh signatures, and distinguishes missing files", async () => {
	const fetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(new Response("tunnel unavailable", { status: 530 }))
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ contents: "recovered" })),
		);
	expect(
		await claudeRunnerMachine(box, fetcher).readFile("runs/another-session"),
	).toBe("recovered");
	expect(fetcher).toHaveBeenCalledTimes(2);
	const headers = fetcher.mock.calls.map(
		([, init]) => init?.headers as Record<string, string>,
	);
	expect(headers[0]?.["x-ytimesy-runner-nonce"]).not.toBe(
		headers[1]?.["x-ytimesy-runner-nonce"],
	);
	const missing = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response('{"error":"ENOENT"}', { status: 500 }));
	expect(await claudeRunnerMachine(box, missing).readFile("absent")).toBeNull();
	expect(missing).toHaveBeenCalledTimes(1);
});

it("types timeouts and rejects malformed success envelopes without replay", async () => {
	for (const [fetcher, reason] of [
		[
			async () => {
				throw new DOMException("private detail", "TimeoutError");
			},
			"timeout",
		],
		[
			async () => new Response('{"stdout":"no exit status"}'),
			"invalid-response",
		],
	] as const) {
		const send = vi.fn<typeof fetch>().mockImplementation(fetcher);
		await expect(
			claudeRunnerMachine(box, send).shell("do work", 100),
		).rejects.toMatchObject({ operation: "exec", reason });
		expect(send).toHaveBeenCalledTimes(1);
	}
});

it("bounds unavailable reads and never replays mutations, including lost or unreadable replies", async () => {
	const down = vi
		.fn<typeof fetch>()
		.mockImplementation(
			async () => new Response("private upstream detail", { status: 502 }),
		);
	const machine = claudeRunnerMachine(box, down);
	await expect(machine.readFile("session")).rejects.toMatchObject({
		operation: "read",
		reason: "http",
		httpStatus: 502,
	});
	expect(down).toHaveBeenCalledTimes(3);
	for (const response of [
		() => new Response("bad", { status: 502 }),
		() => new Response("not json"),
		() => {
			throw new TypeError("private host");
		},
	]) {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => response());
		const target = claudeRunnerMachine(box, fetcher);
		await expect(target.shell("launch", 100)).rejects.toMatchObject({
			operation: "exec",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		await expect(target.writeFile("input", "payload")).rejects.toMatchObject({
			operation: "write",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	}
});

describe("claudeRunnerDiskShare", () => {
	const answer = (value: unknown, status = 200) =>
		(async () =>
			new Response(JSON.stringify(value), {
				status,
			})) as unknown as typeof fetch;

	it("reads the share of the disk in use", async () => {
		expect(
			await claudeRunnerDiskShare(
				box,
				answer({ ok: true, disk: { usedShare: 0.97 } }),
			),
		).toBe(0.97);
	});

	it("is null when the box cannot say, so a health problem never blocks a turn", async () => {
		expect(await claudeRunnerDiskShare(box, answer({ ok: true }))).toBeNull();
		expect(
			await claudeRunnerDiskShare(box, answer({ disk: { usedShare: 7 } })),
		).toBeNull();
		expect(await claudeRunnerDiskShare(box, answer({}, 500))).toBeNull();
		const down = (async () => {
			throw new Error("down");
		}) as unknown as typeof fetch;
		expect(await claudeRunnerDiskShare(box, down)).toBeNull();
	});
});
