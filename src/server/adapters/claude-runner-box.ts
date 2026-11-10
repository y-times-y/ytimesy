import type { ClaudeRunnerBox } from "#/domain/claude-runner";

/**
 * The runner box's three operations (infra/claude-runner-box/server.mjs), as
 * the Claude Code runner's machine: run a shell command, write a file, read a
 * file. Each request is signed like a delivery request plus a single-use
 * nonce, which the box checks.
 */
const EXPIRY_HEADER = "x-ytimesy-delivery-expires";
const SIGNATURE_HEADER = "x-ytimesy-delivery-signature";
const NONCE_HEADER = "x-ytimesy-runner-nonce";
const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");

/** The bytes the box verifies; keep in step with `sign` in the box's server.mjs. */
export async function runnerRequestSignature(
	secret: string,
	method: string,
	target: string,
	expires: string,
	nonce: string,
	body: string,
) {
	const hash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
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
			encoder.encode(`${method}\n${target}\n${expires}\n${hash}\n${nonce}`),
		),
	);
}

async function call<T>(
	box: ClaudeRunnerBox,
	path: "/exec" | "/write" | "/read",
	input: Record<string, unknown>,
	timeoutMs: number,
	fetcher: typeof fetch,
): Promise<T> {
	const body = JSON.stringify(input);
	const expires = String(Date.now() + 30_000);
	const nonce = crypto.randomUUID().replaceAll("-", "");
	const response = await fetcher(new URL(path, box.baseUrl), {
		method: "POST",
		body,
		redirect: "manual",
		signal: AbortSignal.timeout(timeoutMs),
		headers: {
			[EXPIRY_HEADER]: expires,
			[NONCE_HEADER]: nonce,
			[SIGNATURE_HEADER]: await runnerRequestSignature(
				box.secret,
				"POST",
				path,
				expires,
				nonce,
				body,
			),
		},
	});
	if (!response.ok)
		throw new Error(`The runner box answered ${response.status}.`);
	return (await response.json()) as T;
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
			try {
				return (
					await call<{ contents: string }>(
						box,
						"/read",
						{ path },
						60_000,
						fetcher,
					)
				).contents;
			} catch {
				return null;
			}
		},
	};
}
