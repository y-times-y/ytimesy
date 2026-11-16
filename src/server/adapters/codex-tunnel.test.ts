import { spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	codexTunnelCredential,
	codexTunnelEd25519Material,
} from "./codex-tunnel";

const PROXY = resolve(
	import.meta.dirname,
	"../../../scripts/codex-connect-proxy.py",
);
const secret = "s".repeat(64);
const now = 1_800_000_000_000;

function keypair() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		signingKey: privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64"),
		publicKey: publicKey
			.export({ format: "der", type: "spki" })
			.toString("base64"),
		key: publicKey,
	};
}
const workers = keypair();

const header = (password: string) =>
	`Basic ${Buffer.from(`ytimesy:${password}`).toString("base64")}`;

const python =
	spawnSync("python3", ["-I", "-c", "import cryptography"], {
		encoding: "utf8",
	}).status === 0;

/**
 * Runs the proxy's own `authorize` on each header in turn, sharing one nonce
 * store, with the proxy's clock at `at` (ms).
 */
function proxyAuthorizes(
	keys: { publicKey?: string; secret?: string },
	headers: readonly string[],
	at = now,
): boolean[] {
	const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("codex_connect_proxy", sys.argv[1])
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)
data = json.load(sys.stdin)
keys = proxy.Keys(
    proxy.ed25519_public_key(data["publicKey"]) if data.get("publicKey") else None,
    data.get("secret"),
)
seen = {}
print(json.dumps([proxy.authorize(h, keys, seen, data["now"]) for h in data["headers"]]))
`;
	const run = spawnSync("python3", ["-I", "-c", program, PROXY], {
		input: JSON.stringify({ ...keys, headers, now: at / 1000 }),
		encoding: "utf8",
	});
	if (run.status !== 0) throw new Error(run.stderr);
	return JSON.parse(run.stdout);
}

describe("codexTunnelCredential", () => {
	it("signs with Ed25519 when the signing key is set, even with the legacy secret present", async () => {
		const credential = await codexTunnelCredential(
			{
				YTIMESY_CODEX_TUNNEL_SIGNING_KEY: workers.signingKey,
				YTIMESY_CODEX_TUNNEL_SECRET: secret,
			},
			now,
		);
		const [version, expires, nonce, signature] = credential.split(".");
		expect(version).toBe("e1");
		expect(expires).toBe(String(now + 60_000));
		expect(nonce).toMatch(/^[0-9a-f]{32}$/);
		expect(
			verify(
				null,
				codexTunnelEd25519Material(expires, nonce),
				workers.key,
				Buffer.from(signature, "hex"),
			),
		).toBe(true);
	});

	it("falls back to the legacy HMAC only when no signing key is set", async () => {
		const credential = await codexTunnelCredential(
			{ YTIMESY_CODEX_TUNNEL_SECRET: secret },
			now,
		);
		expect(credential).toMatch(/^\d{13}\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
		await expect(codexTunnelCredential({}, now)).rejects.toThrow(
			"signing key is missing",
		);
	});

	it("refuses a malformed signing key instead of quietly using the HMAC", async () => {
		for (const bad of ["not-a-key", "A".repeat(64)])
			await expect(
				codexTunnelCredential(
					{
						YTIMESY_CODEX_TUNNEL_SIGNING_KEY: bad,
						YTIMESY_CODEX_TUNNEL_SECRET: secret,
					},
					now,
				),
			).rejects.toThrow(/YTIMESY_CODEX_TUNNEL_SIGNING_KEY/);
	});
});

describe.skipIf(!python)(
	"the proxy verifies what the Workers sign (python3)",
	() => {
		const ed25519 = () =>
			codexTunnelCredential(
				{ YTIMESY_CODEX_TUNNEL_SIGNING_KEY: workers.signingKey },
				now,
			);
		const legacy = () =>
			codexTunnelCredential({ YTIMESY_CODEX_TUNNEL_SECRET: secret }, now);

		it("accepts an Ed25519 credential once with only the public key", async () => {
			const credential = header(await ed25519());
			expect(
				proxyAuthorizes({ publicKey: workers.publicKey }, [
					credential,
					credential,
				]),
			).toEqual([true, false]);
		});

		it("rejects tampered credentials and another key's signature", async () => {
			const [version, expires, nonce, signature] = (await ed25519()).split(".");
			const flip = (text: string) =>
				text.slice(0, -1) + (text.endsWith("0") ? "1" : "0");
			const other = await codexTunnelCredential(
				{ YTIMESY_CODEX_TUNNEL_SIGNING_KEY: keypair().signingKey },
				now,
			);
			const forged = [
				[version, expires, nonce, flip(signature)],
				[version, expires, flip(nonce), signature],
				[version, String(Number(expires) + 1), nonce, signature],
				["e2", expires, nonce, signature],
				[expires, nonce, signature],
			].map((parts) => header(parts.join(".")));
			forged.push(
				header(other),
				`Basic ${Buffer.from(`someone:${[version, expires, nonce, signature].join(".")}`).toString("base64")}`,
			);
			expect(
				proxyAuthorizes({ publicKey: workers.publicKey, secret }, forged),
			).toEqual(forged.map(() => false));
		});

		it("rejects expired credentials and ones that live too long", async () => {
			const credential = header(await ed25519());
			const keys = { publicKey: workers.publicKey };
			expect(proxyAuthorizes(keys, [credential], now + 60_000)).toEqual([
				false,
			]);
			expect(proxyAuthorizes(keys, [credential], now - 10_000)).toEqual([
				false,
			]);
			expect(proxyAuthorizes(keys, [credential], now + 59_000)).toEqual([true]);
		});

		it("accepts each form only while its key is on the proxy (rollout)", async () => {
			const signed = header(await ed25519());
			const hmac = header(await legacy());
			expect(proxyAuthorizes({ secret }, [signed, hmac])).toEqual([
				false,
				true,
			]);
			expect(
				proxyAuthorizes({ publicKey: workers.publicKey }, [hmac, signed]),
			).toEqual([false, true]);
			expect(
				proxyAuthorizes({ publicKey: workers.publicKey, secret }, [
					signed,
					hmac,
					hmac,
				]),
			).toEqual([true, true, false]);
		});

		it("refuses to start without a usable key, without a restart loop", () => {
			const run = spawnSync("python3", ["-I", PROXY], {
				encoding: "utf8",
				env: {
					PATH: process.env.PATH,
					CODEX_PROXY_PUBLIC_KEY_FILE: "/nonexistent/ytimesy-codex-proxy.pub",
				},
			});
			expect(run.status).toBe(78);
			expect(run.stderr).toContain("refuses to start");
		});
	},
);
