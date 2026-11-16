import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createRunnerServer,
	DISK_WARN_SHARE,
	runnerSignature,
} from "../infra/claude-runner-box/server.mjs";
import { claudeRunnerKeypair } from "../scripts/generate-claude-runner-keypair";
import { runnerRequestHeaders } from "../src/server/adapters/claude-runner-box";

const secret = "s".repeat(40);
let server: ReturnType<typeof createRunnerServer>;
let base = "";
let home = "";

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "runner-box-"));
	server = createRunnerServer({ secret, home });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(
	path: string,
	body: unknown,
	options: { key?: string; nonce?: string; expiresIn?: number } = {},
) {
	const text = JSON.stringify(body);
	const expires = String(Date.now() + (options.expiresIn ?? 30_000));
	const nonce = options.nonce ?? crypto.randomUUID().replaceAll("-", "");
	const signature = runnerSignature(
		options.key ?? secret,
		"POST",
		path,
		expires,
		nonce,
		text,
	);
	const response = await fetch(base + path, {
		method: "POST",
		body: text,
		headers: {
			"x-ytimesy-delivery-expires": expires,
			"x-ytimesy-delivery-signature": signature,
			"x-ytimesy-runner-nonce": nonce,
		},
	});
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	};
}

describe("the runner box", () => {
	it("runs a command, writes a file and reads it back", async () => {
		const ran = await call("/exec", {
			command: "echo hi; echo oops >&2; exit 3",
		});
		expect(ran).toEqual({
			status: 200,
			body: { exitCode: 3, stdout: "hi\n", stderr: "oops\n" },
		});
		expect(
			(await call("/write", { path: "runs/a/prompt", contents: "hello" }))
				.status,
		).toBe(200);
		expect(await call("/read", { path: "runs/a/prompt" })).toEqual({
			status: 200,
			body: { contents: "hello" },
		});
	});

	it("refuses paths outside its home", async () => {
		expect(
			(await call("/write", { path: "../evil", contents: "x" })).status,
		).toBe(400);
		expect((await call("/read", { path: "/etc/passwd" })).status).toBe(400);
	});

	it("refuses a wrong key, an expired request and a replayed nonce", async () => {
		expect(
			(await call("/exec", { command: "true" }, { key: "k".repeat(40) }))
				.status,
		).toBe(403);
		expect(
			(await call("/exec", { command: "true" }, { expiresIn: -1000 })).status,
		).toBe(403);
		const nonce = "a".repeat(32);
		expect((await call("/exec", { command: "true" }, { nonce })).status).toBe(
			200,
		);
		expect((await call("/exec", { command: "true" }, { nonce })).status).toBe(
			403,
		);
	});

	it("does not expose its signing key to spawned commands", async () => {
		vi.stubEnv("RUNNER_SIGNING_KEY", "host-secret-not-for-agent");
		try {
			const result = await call("/exec", {
				command:
					'if [ -z "$RUNNER_SIGNING_KEY" ]; then printf unset; else printf present; fi',
			});
			expect(result.body.stdout).toBe("unset");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("reports spawn exhaustion or missing shell without crashing the runner API", async () => {
		vi.stubEnv("PATH", "/no-shell-here");
		try {
			const result = await call("/exec", { command: "true" });
			expect(result.status).toBe(200);
			expect(result.body.exitCode).toBe(1);
			expect(result.body.stderr).toContain("could not start");
		} finally {
			vi.unstubAllEnvs();
		}
		expect((await fetch(`${base}/health`)).status).toBe(200);
	});

	it("times out the whole short-exec process group, not just its shell", async () => {
		const started = Date.now();
		const result = await call("/exec", {
			command: "sleep 30 & wait",
			timeoutMs: 100,
		});
		expect(result.body.exitCode).not.toBe(0);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("kills a command at its timeout", async () => {
		const result = await call("/exec", { command: "sleep 5", timeoutMs: 200 });
		expect(result.status).toBe(200);
		expect(result.body.exitCode).not.toBe(0);
	});
});

describe("the runner box health", () => {
	async function health(share: number, at = Date.now()) {
		const local = createRunnerServer({
			secret,
			home,
			now: () => at,
			disk: async () => share,
		});
		await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}/health`;
		try {
			return await (await fetch(url)).json();
		} finally {
			await new Promise<void>((resolve) => local.close(() => resolve()));
		}
	}

	it("reports how full the disk is without asking for a signature", async () => {
		expect(await health(0.42)).toEqual({ ok: true, disk: { usedShare: 0.42 } });
	});

	it("logs a warning once the disk is 80% used, not before", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await health(DISK_WARN_SHARE - 0.01);
			expect(warn).not.toHaveBeenCalled();
			await health(0.83);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0][0])).toContain(
				"Runner disk above 80% used",
			);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("the runner box with the edge's Ed25519 public key", () => {
	const edge = claudeRunnerKeypair();
	const legacy = "h".repeat(40);
	let box: ReturnType<typeof createRunnerServer>;
	let origin = "";

	beforeAll(async () => {
		// A leftover shared key beside the public key must not keep working.
		box = createRunnerServer({
			secret: legacy,
			publicKey: edge.publicKey,
			home,
		});
		await new Promise<void>((resolve) => box.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(box.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise<void>((resolve) => box.close(() => resolve())));

	async function send(
		path: string,
		headers: Record<string, string>,
		body = '{"command":"printf ok"}',
		at = origin,
	) {
		return (await fetch(at + path, { method: "POST", body, headers })).status;
	}

	it("accepts a request the edge signed, and only once", async () => {
		const body = '{"command":"printf ok"}';
		const headers = await runnerRequestHeaders(
			{ signingKey: edge.signingKey },
			"/exec",
			body,
		);
		expect(headers["x-ytimesy-runner-signature-ed25519"]).toMatch(
			/^[A-Za-z0-9_-]{86}$/,
		);
		expect(headers["x-ytimesy-delivery-signature"]).toBeUndefined();
		const response = await fetch(`${origin}/exec`, {
			method: "POST",
			body,
			headers,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ stdout: "ok" });
		expect(await send("/exec", headers, body)).toBe(403);
	});

	it("accepts the rollout's double-signed request, which a box without the public key also accepts", async () => {
		const both = { secret: legacy, signingKey: edge.signingKey };
		expect(
			await send(
				"/exec",
				await runnerRequestHeaders(both, "/exec", '{"command":"printf ok"}'),
			),
		).toBe(200);
		const hmacBox = createRunnerServer({ secret: legacy, home });
		await new Promise<void>((resolve) =>
			hmacBox.listen(0, "127.0.0.1", resolve),
		);
		try {
			const at = `http://127.0.0.1:${(hmacBox.address() as AddressInfo).port}`;
			expect(
				await send(
					"/exec",
					await runnerRequestHeaders(both, "/exec", '{"command":"printf ok"}'),
					'{"command":"printf ok"}',
					at,
				),
			).toBe(200);
			// That box cannot check Ed25519, so an Ed25519-only request is refused, not let through.
			expect(
				await send(
					"/exec",
					await runnerRequestHeaders(
						{ signingKey: edge.signingKey },
						"/exec",
						'{"command":"printf ok"}',
					),
					'{"command":"printf ok"}',
					at,
				),
			).toBe(403);
		} finally {
			await new Promise<void>((resolve) => hmacBox.close(() => resolve()));
		}
	});

	it("refuses the shared HMAC key, another keypair and a missing signature once it has the public key", async () => {
		const body = '{"command":"printf ok"}';
		expect(
			await send(
				"/exec",
				await runnerRequestHeaders({ secret: legacy }, "/exec", body),
				body,
			),
		).toBe(403);
		const other = claudeRunnerKeypair();
		expect(
			await send(
				"/exec",
				await runnerRequestHeaders(
					{ signingKey: other.signingKey },
					"/exec",
					body,
				),
				body,
			),
		).toBe(403);
		const { "x-ytimesy-runner-signature-ed25519": _, ...unsigned } =
			await runnerRequestHeaders(
				{ signingKey: edge.signingKey },
				"/exec",
				body,
			);
		expect(await send("/exec", unsigned, body)).toBe(403);
	});

	it("refuses a tampered body, path, expiry, nonce or signature, and an expired request", async () => {
		const body = '{"command":"printf ok"}';
		const signed = () =>
			runnerRequestHeaders({ signingKey: edge.signingKey }, "/exec", body);
		expect(
			await send("/exec", await signed(), '{"command":"printf evil"}'),
		).toBe(403);
		expect(await send("/read", await signed(), body)).toBe(403);
		const later = await signed();
		later["x-ytimesy-delivery-expires"] = String(
			Number(later["x-ytimesy-delivery-expires"]) + 1000,
		);
		expect(await send("/exec", later, body)).toBe(403);
		const renonced = await signed();
		renonced["x-ytimesy-runner-nonce"] = "b".repeat(32);
		expect(await send("/exec", renonced, body)).toBe(403);
		const flipped = await signed();
		const signature = flipped["x-ytimesy-runner-signature-ed25519"];
		flipped["x-ytimesy-runner-signature-ed25519"] =
			(signature[0] === "A" ? "B" : "A") + signature.slice(1);
		expect(await send("/exec", flipped, body)).toBe(403);
		const expired = await runnerRequestHeaders(
			{ signingKey: edge.signingKey },
			"/exec",
			body,
			Date.now() - 60_000,
		);
		expect(await send("/exec", expired, body)).toBe(403);
	});

	it("will not start without a way to verify, or with a key that is not Ed25519", () => {
		expect(() => createRunnerServer({ home })).toThrow(/too short/);
		expect(() => createRunnerServer({ secret: "short", home })).toThrow(
			/too short/,
		);
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.publicKey.export({ format: "der", type: "spki" })
			.toString("base64");
		expect(() => createRunnerServer({ publicKey: rsa, home })).toThrow(
			/Ed25519/,
		);
		expect(() =>
			createRunnerServer({ publicKey: edge.publicKey, home }),
		).not.toThrow();
	});

	it("makes keys in the shapes the settings check (provision.py, claudeRunnerFor)", () => {
		expect(edge.publicKey).toMatch(/^[A-Za-z0-9+/]{59}=$/);
		expect(edge.signingKey).toMatch(/^[A-Za-z0-9+/]{64}$/);
	});
});
