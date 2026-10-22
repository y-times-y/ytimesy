import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openai } from "@ai-sdk/openai";
import type { ToolSet } from "ai";

/**
 * OpenAI models in Amazon Bedrock for the Harbor bridge (route `bedrock`).
 *
 * Transport: the OpenAI Responses API, by default on the bedrock-mantle
 * endpoint (https://bedrock-mantle.<region>.api.aws/openai/v1/responses).
 * It speaks the same request and stream format as api.openai.com, so the
 * product's OpenAI Responses transport (apiModelRuntime, provider "openai")
 * runs unchanged: function tools, streaming, reasoning effort, encrypted
 * reasoning with store=false and prompt caching. Mantle also runs Bedrock's
 * hosted Web Search (tool type web_search, the same tool Codex uses on
 * Bedrock); it serves the foundation id (`openai.<model>`) in the Region.
 * The bedrock-runtime endpoint
 * (https://bedrock-runtime.<region>.amazonaws.com/openai/v1) remains as an
 * option: no server-side tools, and the model is an inference profile,
 * `global.openai.<model>` (list price) or a geographic one such as
 * `us.openai.<model>` (+10%).
 *
 * Auth: each request is signed with AWS Signature Version 4 (service
 * `bedrock-mantle` or `bedrock`) from the operator's AWS credentials: an AWS
 * profile from the shared credentials file, or the standard AWS_* environment
 * variables. No key is written to a file or logged.
 */

export const BEDROCK_DEFAULT_REGION = "us-east-1";
export const BEDROCK_DEFAULT_PROFILE_NAME = "harbor";
export const BEDROCK_DEFAULT_MODEL = "openai.gpt-6.1-sol";

export const BEDROCK_ENDPOINTS = ["mantle", "runtime"] as const;
export type BedrockEndpoint = (typeof BEDROCK_ENDPOINTS)[number];

/**
 * Bedrock Web Search: $12.00 per 1,000 queries (AWS price list, usage type
 * USE1-Bedrock-Websearch-Queries, checked 2026-10-21).
 */
export const BEDROCK_WEB_SEARCH_USD = 0.012;
/** The commercial Regions Bedrock Web Search runs in. */
export const BEDROCK_WEB_SEARCH_REGIONS: readonly string[] = [
	"us-east-1",
	"us-east-2",
	"us-west-2",
];

/**
 * Bedrock Web Search on mantle: OpenAI's web_search tool shape, with Fetch
 * kept to Bedrock's index and cache (external_web_access false), as Codex
 * sets it on Bedrock. The same context size as the product's OpenAI search.
 */
export function bedrockWebSearchTools(): ToolSet {
	return {
		web_search: openai.tools.webSearch({
			searchContextSize: "medium",
			externalWebAccess: false,
		}),
	};
}

/** Searches in one web_search result: each query of a search, else one. */
export function webSearchQueries(result: unknown) {
	const action = (result as { action?: { type?: string; queries?: unknown } })
		?.action;
	if (action?.type === "search" && Array.isArray(action.queries))
		return Math.max(1, action.queries.length);
	return 1;
}

/**
 * Dollars for the Bedrock Web Search queries in a run's events: every
 * web_search result the provider returned (not the loop's synthetic
 * cited-search entries), each query at the list price.
 */
export function bedrockWebSearchUsd(
	events: readonly {
		type: string;
		id?: string;
		name?: string;
		output?: unknown;
	}[],
) {
	let queries = 0;
	for (const event of events)
		if (
			event.type === "tool-result" &&
			event.name === "web_search" &&
			!event.id?.startsWith("cited-search-")
		)
			queries += webSearchQueries(event.output);
	return queries * BEDROCK_WEB_SEARCH_USD;
}

export const BEDROCK_INFERENCE_PROFILES = ["global", "us"] as const;
export type BedrockInferenceProfile =
	(typeof BEDROCK_INFERENCE_PROFILES)[number];

const PROFILED_OPENAI =
	/^(?:global|us|us-gov|eu|apac|jp|au|ca)\.openai\.gpt-[\w.-]+$/;
const FOUNDATION_OPENAI = /^openai\.gpt-[\w.-]+$/;

export function bedrockBaseUrl(
	region: string,
	endpoint: BedrockEndpoint = "mantle",
) {
	if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region))
		throw new Error(`"${region}" is not an AWS Region.`);
	return endpoint === "mantle"
		? `https://bedrock-mantle.${region}.api.aws/openai/v1`
		: `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
}

/** The SigV4 service name an endpoint's requests are signed for. */
export function bedrockSigningService(endpoint: BedrockEndpoint) {
	return endpoint === "mantle" ? "bedrock-mantle" : "bedrock";
}

/**
 * The id a Bedrock OpenAI model is requested by. Mantle serves the
 * foundation id in the Region (`openai.gpt-6-luna`; a profile prefix is
 * dropped). bedrock-runtime needs an inference profile: `openai.gpt-6-luna`
 * on the global profile is `global.openai.gpt-6-luna`, and an id that
 * already names a profile keeps it.
 */
export function bedrockModelId(
	modelId: string,
	route: { endpoint: BedrockEndpoint; profile: BedrockInferenceProfile },
) {
	if (route.endpoint === "mantle") {
		if (PROFILED_OPENAI.test(modelId))
			return modelId.slice(modelId.indexOf(".") + 1);
		if (FOUNDATION_OPENAI.test(modelId)) return modelId;
	} else {
		if (PROFILED_OPENAI.test(modelId)) return modelId;
		if (FOUNDATION_OPENAI.test(modelId)) return `${route.profile}.${modelId}`;
	}
	throw new Error(
		`"${modelId}" is not a Bedrock OpenAI model id; use openai.<model> (for example openai.gpt-6.1-sol) or an inference profile id (global.openai.<model>).`,
	);
}

export type AwsCredentials = {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
};

const ACCESS_KEY_SHAPE = /^(?:AKIA|ASIA)[A-Z0-9]{12,}$/;

/** One profile's keys from an AWS shared credentials (INI) file. */
export function parseCredentialsFile(
	text: string,
	profile: string,
): AwsCredentials | null {
	let section: string | null = null;
	const values: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[\s*(?:profile\s+)?([^\]]+?)\s*\]$/.exec(line);
		if (header) {
			section = header[1];
			continue;
		}
		if (section !== profile) continue;
		const eq = line.indexOf("=");
		if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	if (!values.aws_access_key_id || !values.aws_secret_access_key) return null;
	return {
		accessKeyId: values.aws_access_key_id,
		secretAccessKey: values.aws_secret_access_key,
		...(values.aws_session_token
			? { sessionToken: values.aws_session_token }
			: {}),
	};
}

/**
 * The operator's AWS credentials, never logged. An explicit profile
 * (YTIMESY_HARBOR_AWS_PROFILE, else AWS_PROFILE) is read from the shared
 * credentials file; without one, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY
 * (and AWS_SESSION_TOKEN) win when set, else the `harbor` profile.
 */
export async function bedrockCredentials(
	env: Record<string, string | undefined>,
	read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<AwsCredentials> {
	const explicit = env.YTIMESY_HARBOR_AWS_PROFILE || env.AWS_PROFILE;
	let credentials: AwsCredentials | null = null;
	let source: string;
	if (!explicit && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
		source = "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY";
		credentials = {
			accessKeyId: env.AWS_ACCESS_KEY_ID.trim(),
			secretAccessKey: env.AWS_SECRET_ACCESS_KEY.trim(),
			...(env.AWS_SESSION_TOKEN
				? { sessionToken: env.AWS_SESSION_TOKEN.trim() }
				: {}),
		};
	} else {
		const profile = explicit || BEDROCK_DEFAULT_PROFILE_NAME;
		const file =
			env.AWS_SHARED_CREDENTIALS_FILE ||
			join(env.HOME || homedir(), ".aws", "credentials");
		source = `AWS profile "${profile}" in ${file}`;
		const text = await read(file).catch(() => "");
		credentials = parseCredentialsFile(text, profile);
	}
	if (
		!credentials ||
		!ACCESS_KEY_SHAPE.test(credentials.accessKeyId) ||
		!credentials.secretAccessKey
	)
		throw new Error(`Expected AWS credentials from ${source}.`);
	return credentials;
}

const sha256Hex = (data: string) =>
	createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: string | Buffer, data: string) =>
	createHmac("sha256", key).update(data, "utf8").digest();

const encodeRfc3986 = (value: string) =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/**
 * AWS Signature Version 4 headers for one request (Authorization,
 * X-Amz-Date, X-Amz-Content-Sha256 and, for temporary keys,
 * X-Amz-Security-Token). Signs host and every x-amz-* header.
 */
export function signAwsRequest(input: {
	method: string;
	url: string;
	body: string;
	credentials: AwsCredentials;
	region: string;
	service: string;
	now?: Date;
}): Record<string, string> {
	const url = new URL(input.url);
	const amzDate = (input.now ?? new Date())
		.toISOString()
		.replace(/[:-]|\.\d{3}/g, "");
	const day = amzDate.slice(0, 8);
	const payloadHash = sha256Hex(input.body);
	const signed: Record<string, string> = {
		host: url.host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
		...(input.credentials.sessionToken
			? { "x-amz-security-token": input.credentials.sessionToken }
			: {}),
	};
	const names = Object.keys(signed).sort();
	// Non-S3 services encode each path segment twice.
	const canonicalPath =
		url.pathname
			.split("/")
			.map((segment) =>
				encodeRfc3986(encodeRfc3986(decodeURIComponent(segment))),
			)
			.join("/") || "/";
	const canonicalQuery = [...url.searchParams]
		.map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)])
		.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const canonicalRequest = [
		input.method.toUpperCase(),
		canonicalPath,
		canonicalQuery,
		names.map((name) => `${name}:${signed[name].trim()}\n`).join(""),
		names.join(";"),
		payloadHash,
	].join("\n");
	const scope = `${day}/${input.region}/${input.service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256Hex(canonicalRequest),
	].join("\n");
	const key = hmac(
		hmac(
			hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region),
			input.service,
		),
		"aws4_request",
	);
	const signature = createHmac("sha256", key)
		.update(stringToSign, "utf8")
		.digest("hex");
	const { host: _host, ...headers } = signed;
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
	};
}

/**
 * A fetch that signs each Bedrock request (replacing the OpenAI client's
 * bearer header) and refuses any other host, so AWS credentials never leave
 * for another origin. The transport guard sits underneath: its resends of a
 * cut stream reuse the signature, well inside AWS's 5-minute window.
 */
export function bedrockSigningFetch(input: {
	credentials: AwsCredentials;
	region: string;
	endpoint: BedrockEndpoint;
	fetch: typeof globalThis.fetch;
	/**
	 * The client's model id and the Bedrock id sent in its place
	 * (see bedrockRuntime in runtime.ts); unset leaves bodies unchanged.
	 */
	model?: { client: string; profile: string };
	now?: () => Date;
}): typeof globalThis.fetch {
	const host = new URL(bedrockBaseUrl(input.region, input.endpoint)).host;
	return async (request, init) => {
		const url =
			typeof request === "string"
				? request
				: request instanceof URL
					? request.href
					: request.url;
		if (new URL(url).host !== host)
			throw new Error(`The Bedrock route only sends requests to ${host}.`);
		let body = init?.body ?? "";
		if (typeof body !== "string")
			throw new Error("The Bedrock route signs string request bodies only.");
		if (input.model && body.includes('"model"')) {
			const parsed = JSON.parse(body) as { model?: unknown };
			if (parsed.model === input.model.client) {
				parsed.model = input.model.profile;
				body = JSON.stringify(parsed);
			}
		}
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		headers.delete("authorization");
		for (const [name, value] of Object.entries(
			signAwsRequest({
				method,
				url,
				body,
				credentials: input.credentials,
				region: input.region,
				service: bedrockSigningService(input.endpoint),
				now: input.now?.(),
			}),
		))
			headers.set(name, value);
		return input.fetch(url, { ...init, method, headers, body });
	};
}

/** A response stream stopped at its wall-clock or idle limit (network-shaped, so the loop resamples the step). */
export class ResponseTimeLimit extends Error {
	readonly code = "ETIMEDOUT";
	constructor(reason: string) {
		super(`Model response stopped: ${reason} (ETIMEDOUT).`);
		this.name = "ResponseTimeLimit";
	}
}

const duration = (ms: number) =>
	ms >= 60_000
		? `${Math.round(ms / 60_000)} minutes`
		: `${Math.round(ms / 1000)} s`;

/** Per model request on the bedrock route: one response's whole stream, and the longest silence in it. */
export const BEDROCK_RESPONSE_LIMITS = {
	totalMs: 20 * 60_000,
	idleMs: 10 * 60_000,
} as const;

/**
 * Bounds one request's wall time: the whole response (headers and body) gets
 * `totalMs`, and no more than `idleMs` may pass without a byte. A Bedrock
 * response once streamed for 30 minutes (1.6 MB) and would have run to the
 * trial's timeout. At a limit the request is aborted and its body fails with
 * an ETIMEDOUT error, which the model loop treats as an interrupted stream:
 * the step is resampled from the history before it (a few times, with
 * backoff), then the turn fails.
 */
export function responseTimeLimitFetch(
	fetch: typeof globalThis.fetch,
	limits: {
		readonly totalMs: number;
		readonly idleMs: number;
	} = BEDROCK_RESPONSE_LIMITS,
	now: () => number = Date.now,
): typeof globalThis.fetch {
	return async (request, init) => {
		const startedAt = now();
		const aborter = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped: ResponseTimeLimit | undefined;
		let body: ReadableStreamDefaultController<Uint8Array> | undefined;
		const clear = () => clearTimeout(timer);
		const arm = () => {
			clear();
			const total = startedAt + limits.totalMs - now();
			const ms = Math.max(0, Math.min(total, limits.idleMs));
			timer = setTimeout(() => {
				stopped = new ResponseTimeLimit(
					total <= limits.idleMs
						? `the response ran past ${duration(limits.totalMs)}`
						: `no data for ${duration(limits.idleMs)}`,
				);
				aborter.abort(stopped);
				try {
					body?.error(stopped);
				} catch {
					/* Already closed. */
				}
			}, ms);
		};
		arm();
		let response: Response;
		try {
			response = await fetch(request, {
				...init,
				signal: init?.signal
					? AbortSignal.any([init.signal, aborter.signal])
					: aborter.signal,
			});
		} catch (error) {
			clear();
			throw stopped ?? error;
		}
		if (!response.body) {
			clear();
			return response;
		}
		const reader = response.body.getReader();
		arm();
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					body = controller;
				},
				async pull(controller) {
					try {
						const { done, value } = await reader.read();
						if (stopped) return;
						if (done) {
							clear();
							controller.close();
							return;
						}
						arm();
						controller.enqueue(value);
					} catch (error) {
						clear();
						if (!stopped) controller.error(error);
					}
				},
				cancel(reason) {
					clear();
					return reader.cancel(reason);
				},
			}),
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		);
	};
}
