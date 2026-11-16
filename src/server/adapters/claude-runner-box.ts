import { ClaudeRunnerTransportFailure } from "#/domain/api-turn-failure";
import type { ClaudeRunnerBox } from "#/domain/claude-runner";

/**
 * The runner box's three operations (infra/claude-runner-box/server.mjs), as
 * the Claude Code runner's machine: run a shell command, write a file, read a
 * file. Each request carries an expiry and a single-use nonce, signed with the
 * edge's Ed25519 private key (the box holds only the public key) and, while
 * the legacy shared key is still configured, with the old HMAC as well, so a
 * box verifies whichever it is set up for (docs/claude-code-placement.md).
 */
const EXPIRY_HEADER = "x-ytimesy-delivery-expires";
const SIGNATURE_HEADER = "x-ytimesy-delivery-signature";
const ED25519_HEADER = "x-ytimesy-runner-signature-ed25519";
const NONCE_HEADER = "x-ytimesy-runner-nonce";
const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");

const base64url = (bytes: ArrayBuffer) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

/** The bytes both signatures cover; keep in step with `runnerSignedMaterial` in the box's server.mjs. */
async function signedMaterial(
	method: string,
	target: string,
	expires: string,
	nonce: string,
	body: string,
) {
	const hash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
	return encoder.encode(`${method}\n${target}\n${expires}\n${hash}\n${nonce}`);
}

/** The legacy HMAC signature (hex), for boxes not yet given the edge's public key. */
export async function runnerRequestSignature(
	secret: string,
	method: string,
	target: string,
	expires: string,
	nonce: string,
	body: string,
) {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign(
			"HMAC",
			key,
			await signedMaterial(method, target, expires, nonce, body),
		),
	);
}

const signingKeys = new Map<string, Promise<CryptoKey>>();

/** The imported private key, once per isolate per configured value. */
function ed25519Key(pkcs8Base64: string) {
	let key = signingKeys.get(pkcs8Base64);
	if (!key) {
		key = crypto.subtle
			.importKey(
				"pkcs8",
				Uint8Array.from(atob(pkcs8Base64), (char) => char.charCodeAt(0)),
				{ name: "Ed25519" },
				false,
				["sign"],
			)
			.catch((error: unknown) => {
				signingKeys.delete(pkcs8Base64);
				throw new Error(
					"YTIMESY_CLAUDE_RUNNER_SIGNING_KEY is not a base64 PKCS8 Ed25519 private key.",
					{ cause: error },
				);
			});
		signingKeys.set(pkcs8Base64, key);
	}
	return key;
}

/** The Ed25519 signature (base64url, 86 characters) the box verifies with RUNNER_PUBLIC_KEY. */
export async function runnerRequestEd25519Signature(
	signingKey: string,
	method: string,
	target: string,
	expires: string,
	nonce: string,
	body: string,
) {
	return base64url(
		await crypto.subtle.sign(
			{ name: "Ed25519" },
			await ed25519Key(signingKey),
			await signedMaterial(method, target, expires, nonce, body),
		),
	);
}

/** The headers that authorize one request: expiry, nonce and every signature the edge can make. */
export async function runnerRequestHeaders(
	box: Pick<ClaudeRunnerBox, "secret" | "signingKey">,
	path: string,
	body: string,
	now = Date.now(),
): Promise<Record<string, string>> {
	const expires = String(now + 30_000);
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const args = ["POST", path, expires, nonce, body] as const;
	return {
		[EXPIRY_HEADER]: expires,
		[NONCE_HEADER]: nonce,
		...(box.secret
			? {
					[SIGNATURE_HEADER]: await runnerRequestSignature(box.secret, ...args),
				}
			: {}),
		...(box.signingKey
			? {
					[ED25519_HEADER]: await runnerRequestEd25519Signature(
						box.signingKey,
						...args,
					),
				}
			: {}),
	};
}

async function call<T>(
	box: ClaudeRunnerBox,
	path: "/exec" | "/write" | "/read",
	input: Record<string, unknown>,
	timeoutMs: number,
	fetcher: typeof fetch,
): Promise<T> {
	const body = JSON.stringify(input);
	// Outside the transport try: a misconfigured key is not a network failure to retry.
	const headers = await runnerRequestHeaders(box, path, body);
	let response: Response;
	try {
		response = await fetcher(new URL(path, box.baseUrl), {
			method: "POST",
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
			headers,
		});
	} catch (error) {
		throw new ClaudeRunnerTransportFailure(
			path.slice(1) as "exec" | "write" | "read",
			error instanceof Error &&
				(error.name === "TimeoutError" || error.name === "AbortError")
				? "timeout"
				: "network",
		);
	}
	// The box reports a missing file as HTTP 500 with this fixed code.
	if (path === "/read" && response.status === 500) {
		const missing = (await response.json().catch(() => null)) as {
			error?: unknown;
		} | null;
		if (missing?.error === "ENOENT") return { contents: null } as T;
	}
	if (!response.ok)
		throw new ClaudeRunnerTransportFailure(
			path.slice(1) as "exec" | "write" | "read",
			"http",
			response.status,
		);
	try {
		const result = (await response.json()) as Record<string, unknown> | null;
		const valid =
			result &&
			typeof result === "object" &&
			(path === "/exec"
				? Number.isInteger(result.exitCode) &&
					typeof result.stdout === "string" &&
					typeof result.stderr === "string"
				: path === "/read"
					? typeof result.contents === "string"
					: result.ok === true);
		if (!valid) throw new Error("invalid response");
		return result as T;
	} catch (error) {
		throw new ClaudeRunnerTransportFailure(
			path.slice(1) as "exec" | "write" | "read",
			error instanceof Error &&
				(error.name === "TimeoutError" || error.name === "AbortError")
				? "timeout"
				: "invalid-response",
		);
	}
}

/** The share of the box's disk in use (0-1), or null when it could not be read. */
export async function claudeRunnerDiskShare(
	box: ClaudeRunnerBox,
	fetcher: typeof fetch = fetch,
): Promise<number | null> {
	try {
		const response = await fetcher(new URL("/health", box.baseUrl), {
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;
		const share = (
			(await response.json()) as { disk?: { usedShare?: unknown } }
		).disk?.usedShare;
		return typeof share === "number" && share >= 0 && share <= 1 ? share : null;
	} catch {
		return null;
	}
}

/** The machine the Claude Code runner drives, backed by one runner box. */
export function claudeRunnerMachine(
	box: ClaudeRunnerBox,
	fetcher: typeof fetch = fetch,
) {
	return {
		shell: async (command: string, timeoutMs: number) => {
			const result = await call<{
				exitCode: number;
				stdout: string;
				stderr: string;
			}>(box, "/exec", { command, timeoutMs }, timeoutMs + 10_000, fetcher);
			return {
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		},
		writeFile: async (path: string, contents: string) => {
			await call(box, "/write", { path, contents }, 60_000, fetcher);
		},
		readFile: async (path: string) => {
			for (let attempt = 0; ; attempt++) {
				try {
					return (
						await call<{ contents: string | null }>(
							box,
							"/read",
							{ path },
							10_000,
							fetcher,
						)
					).contents;
				} catch (error) {
					if (
						!(error instanceof ClaudeRunnerTransportFailure) ||
						!error.retryable ||
						attempt >= 2
					)
						throw error;
					await new Promise((resolve) =>
						setTimeout(resolve, 250 * (attempt + 1)),
					);
				}
			}
		},
	};
}
