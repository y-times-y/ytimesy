import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OpenAI models in Amazon Bedrock for the Harbor bridge (route `bedrock`).
 *
 * Transport: the OpenAI Responses API on the bedrock-runtime endpoint
 * (https://bedrock-runtime.<region>.amazonaws.com/openai/v1/responses),
 * AWS's recommended endpoint for these models. It speaks the same request
 * and stream format as api.openai.com, so the product's OpenAI Responses
 * transport (apiModelRuntime, provider "openai") runs unchanged: function
 * tools, streaming, reasoning effort, encrypted reasoning with store=false
 * and prompt caching. It has no server-side tools (no hosted web search) and
 * needs an inference profile as the model: `global.openai.<model>` (list
 * price) or a geographic one such as `us.openai.<model>` (+10%).
 *
 * Auth: each request is signed with AWS Signature Version 4 (service
 * `bedrock`) from the operator's AWS credentials: an AWS profile from the
 * shared credentials file, or the standard AWS_* environment variables. No
 * key is written to a file or logged.
 */

export const BEDROCK_DEFAULT_REGION = "us-east-1";
export const BEDROCK_DEFAULT_PROFILE_NAME = "harbor";
export const BEDROCK_DEFAULT_MODEL = "openai.gpt-6.1-sol";

export const BEDROCK_INFERENCE_PROFILES = ["global", "us"] as const;
export type BedrockInferenceProfile =
	(typeof BEDROCK_INFERENCE_PROFILES)[number];

const PROFILED_OPENAI =
	/^(?:global|us|us-gov|eu|apac|jp|au|ca)\.openai\.gpt-[\w.-]+$/;
const FOUNDATION_OPENAI = /^openai\.gpt-[\w.-]+$/;

export function bedrockBaseUrl(region: string) {
	if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region))
		throw new Error(`"${region}" is not an AWS Region.`);
	return `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
}

/**
 * The inference profile a Bedrock OpenAI model is requested through:
 * `openai.gpt-6-luna` on the global profile is `global.openai.gpt-6-luna`.
 * An id that already names a profile keeps it.
 */
export function bedrockModelId(
	modelId: string,
	profile: BedrockInferenceProfile,
) {
	if (PROFILED_OPENAI.test(modelId)) return modelId;
	if (FOUNDATION_OPENAI.test(modelId)) return `${profile}.${modelId}`;
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
	fetch: typeof globalThis.fetch;
	/**
	 * The client's model id and the inference profile sent in its place
	 * (see bedrockRuntime in runtime.ts); unset leaves bodies unchanged.
	 */
	model?: { client: string; profile: string };
	now?: () => Date;
}): typeof globalThis.fetch {
	const host = new URL(bedrockBaseUrl(input.region)).host;
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
				service: "bedrock",
				now: input.now?.(),
			}),
		))
			headers.set(name, value);
		return input.fetch(url, { ...init, method, headers, body });
	};
}
