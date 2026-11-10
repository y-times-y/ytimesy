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
