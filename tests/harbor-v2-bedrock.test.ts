import { createHash, createHmac } from "node:crypto";
import { streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
	bedrockCredentials,
	bedrockModelId,
	bedrockSigningFetch,
	parseCredentialsFile,
	signAwsRequest,
} from "../evals/harbor_v2/bedrock";
import { harborBridgeConfig, routeProvider } from "../evals/harbor_v2/config";
import { harborRuntime } from "../evals/harbor_v2/runtime";
import { usageCostUsd } from "../src/domain/model-pricing";

vi.mock("../src/server/adapters/browse-models", () => ({
	browseModels: async () => [
		{ id: "openai/gpt-6.1-sol", contextWindow: 1_050_000 },
		{ id: "openai/gpt-6-luna", contextWindow: 400_000 },
	],
}));

// Fake, well-formed keys: never real credentials.
const FAKE_KEY = "AKIAFAKEFAKEFAKE1234";
const FAKE_SECRET = "fake/secret/for/tests/only";

const bedrock = {
	YTIMESY_HARBOR_ROUTE: "bedrock",
	YTIMESY_HARBOR_APPROVED: "bedrock",
	YTIMESY_HARBOR_TOTAL_USD_CAP: "1",
	YTIMESY_HARBOR_TRIAL_USD_CAP: "0.5",
	YTIMESY_HARBOR_SPEND_LEDGER: "/tmp/bedrock-ledger.jsonl",
};

describe("bedrock route config", () => {
	it("defaults to Sol on the global profile in us-east-1, without web search", () => {
		const config = harborBridgeConfig(bedrock);
		expect(config).toMatchObject({
			route: "bedrock",
			modelId: "global.openai.gpt-6.1-sol",
			webSearch: false,
			keyFile: null,
			keyEnv: null,
			trialUsdCap: 0.5,
			total: { capUsd: 1 },
			bedrock: {
				region: "us-east-1",
				profile: "global",
				baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
			},
		});
		expect(config.billing.price).toMatchObject({
			input: 2,
			cacheRead: 0.1,
			cacheWrite: 2.5,
			output: 10,
		});
		expect(routeProvider("bedrock")).toBe("openai");
	});

	it("runs Sol as lead and checker judge, Luna as sidekick, checker worker and classifier", () => {
		const config = harborBridgeConfig({
			...bedrock,
			YTIMESY_HARBOR_MODEL: "openai.gpt-6.1-sol",
			YTIMESY_HARBOR_VARIANT:
				"lead=fusion,review=on,checkerMode=pair,roleModels.checker=bedrock:openai.gpt-6.1-sol@high,roleModels.writer=bedrock:openai.gpt-6-luna,roleModels.checkerWorker=bedrock:openai.gpt-6-luna,roleModels.classifier=openai.gpt-6-luna@low",
		});
		expect(config.modelId).toBe("global.openai.gpt-6.1-sol");
		expect(config.checker).toMatchObject({
			modelId: "global.openai.gpt-6.1-sol",
			effort: "high",
		});
		for (const role of ["writer", "checkerWorker", "classifier"] as const)
			expect(config.roles[role]?.modelId).toBe("global.openai.gpt-6-luna");
		expect(config.roles.classifier?.effort).toBe("low");
		expect(config.roles.writer?.billing.price).toMatchObject({
			input: 0.1,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			output: 0.5,
		});
	});

	it("prices the regional profile 10% above list", () => {
		const config = harborBridgeConfig({
			...bedrock,
			YTIMESY_HARBOR_BEDROCK_PROFILE: "us",
			YTIMESY_HARBOR_BEDROCK_REGION: "us-west-2",
		});
		expect(config.modelId).toBe("us.openai.gpt-6.1-sol");
		expect(config.bedrock?.baseUrl).toBe(
			"https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1",
		);
		expect(config.billing.price?.input).toBeCloseTo(2.2, 10);
		expect(config.billing.price?.cacheWrite).toBeCloseTo(2.75, 10);
	});

	it("refuses what the route cannot run", () => {
		expect(() =>
			harborBridgeConfig({ ...bedrock, YTIMESY_HARBOR_APPROVED: "openai-api" }),
		).toThrow(/YTIMESY_HARBOR_APPROVED=bedrock/);
		expect(() =>
			harborBridgeConfig({
				...bedrock,
				YTIMESY_HARBOR_TOTAL_USD_CAP: undefined,
				YTIMESY_HARBOR_SPEND_LEDGER: undefined,
			}),
		).toThrow(/needs a total cap/);
		expect(() =>
			harborBridgeConfig({ ...bedrock, YTIMESY_HARBOR_WEB_SEARCH: "on" }),
		).toThrow(/no hosted web search/);
		expect(() =>
			harborBridgeConfig({ ...bedrock, YTIMESY_HARBOR_BEDROCK_PROFILE: "eu" }),
		).toThrow(/must be one of global, us/);
		expect(() =>
			harborBridgeConfig({ ...bedrock, YTIMESY_HARBOR_MODEL: "gpt-6.1-sol" }),
		).toThrow(/not a Bedrock OpenAI model id/);
		expect(() =>
			harborBridgeConfig({
				...bedrock,
				YTIMESY_HARBOR_VARIANT: "roleModels.checker=codex:gpt-6-luna",
			}),
		).toThrow(/codex-subscription/);
		expect(() =>
			harborBridgeConfig({
				YTIMESY_HARBOR_ROUTE: "openai-api",
				YTIMESY_HARBOR_APPROVED: "openai-api",
				YTIMESY_HARBOR_TOTAL_USD_CAP: "1",
				YTIMESY_HARBOR_SPEND_LEDGER: "/tmp/l.jsonl",
				YTIMESY_HARBOR_VARIANT: "roleModels.checker=bedrock:openai.gpt-6-luna",
			}),
		).toThrow(/needs YTIMESY_HARBOR_ROUTE=bedrock/);
	});

	it("maps foundation ids onto inference profiles", () => {
		expect(bedrockModelId("openai.gpt-6-luna", "us")).toBe(
			"us.openai.gpt-6-luna",
		);
		expect(bedrockModelId("global.openai.gpt-6-luna", "us")).toBe(
			"global.openai.gpt-6-luna",
		);
	});
});

describe("bedrock credentials", () => {
	const file = `[default]\naws_access_key_id = AKIADEFAULTDEFAULT00\naws_secret_access_key = other\n\n[harbor]\naws_access_key_id = ${FAKE_KEY}\naws_secret_access_key = ${FAKE_SECRET}\n`;

	it("reads one profile from the shared credentials file", () => {
		expect(parseCredentialsFile(file, "harbor")).toEqual({
			accessKeyId: FAKE_KEY,
			secretAccessKey: FAKE_SECRET,
		});
		expect(parseCredentialsFile(file, "missing")).toBeNull();
	});

	it("uses the harbor profile by default, an explicit profile, or the AWS_* variables", async () => {
		const read = async (path: string) => {
			expect(path).toBe("/home/op/.aws/credentials");
			return file;
		};
		await expect(
			bedrockCredentials({ HOME: "/home/op" }, read),
		).resolves.toMatchObject({ accessKeyId: FAKE_KEY });
		await expect(
			bedrockCredentials({ HOME: "/home/op", AWS_PROFILE: "default" }, read),
		).resolves.toMatchObject({ accessKeyId: "AKIADEFAULTDEFAULT00" });
		await expect(
			bedrockCredentials(
				{
					AWS_ACCESS_KEY_ID: "ASIAFAKEFAKEFAKE5678",
					AWS_SECRET_ACCESS_KEY: FAKE_SECRET,
					AWS_SESSION_TOKEN: "token",
				},
				read,
			),
		).resolves.toEqual({
			accessKeyId: "ASIAFAKEFAKEFAKE5678",
			secretAccessKey: FAKE_SECRET,
			sessionToken: "token",
		});
	});

	it("fails without keys, naming the source but no secret", async () => {
		const error = await bedrockCredentials(
			{ HOME: "/home/op", YTIMESY_HARBOR_AWS_PROFILE: "missing" },
			async () => file,
		).catch((caught: Error) => caught);
		expect(String(error)).toMatch(/AWS profile "missing"/);
		expect(String(error)).not.toContain(FAKE_SECRET);
	});
});

describe("SigV4 signing", () => {
	it("matches an independent computation of AWS Signature Version 4", () => {
		const now = new Date("2026-10-21T12:34:56.789Z");
		const body = '{"model":"global.openai.gpt-6-luna"}';
		const headers = signAwsRequest({
			method: "POST",
			url: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses",
			body,
			credentials: { accessKeyId: FAKE_KEY, secretAccessKey: FAKE_SECRET },
			region: "us-east-1",
			service: "bedrock",
			now,
		});
		const hash = (text: string) =>
			createHash("sha256").update(text).digest("hex");
		const mac = (key: string | Buffer, text: string) =>
			createHmac("sha256", key).update(text).digest();
		const canonical = [
			"POST",
			"/openai/v1/responses",
			"",
			`host:bedrock-runtime.us-east-1.amazonaws.com\nx-amz-content-sha256:${hash(body)}\nx-amz-date:20261021T123456Z\n`,
			"host;x-amz-content-sha256;x-amz-date",
			hash(body),
		].join("\n");
		const scope = "20261021/us-east-1/bedrock/aws4_request";
		const key = mac(
			mac(mac(mac(`AWS4${FAKE_SECRET}`, "20261021"), "us-east-1"), "bedrock"),
			"aws4_request",
		);
		const signature = createHmac("sha256", key)
			.update(
				["AWS4-HMAC-SHA256", "20261021T123456Z", scope, hash(canonical)].join(
					"\n",
				),
			)
			.digest("hex");
		expect(headers).toEqual({
			"x-amz-date": "20261021T123456Z",
			"x-amz-content-sha256": hash(body),
			authorization: `AWS4-HMAC-SHA256 Credential=${FAKE_KEY}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
		});
	});

	it("replaces the client's bearer header and refuses other hosts", async () => {
		const sent: { url: string; headers: Headers }[] = [];
		const signed = bedrockSigningFetch({
			credentials: {
				accessKeyId: FAKE_KEY,
				secretAccessKey: FAKE_SECRET,
				sessionToken: "session",
			},
			region: "us-east-1",
			fetch: async (url, init) => {
				sent.push({ url: String(url), headers: new Headers(init?.headers) });
				return new Response("{}");
			},
		});
		await signed(
			"https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses",
			{
				method: "POST",
				body: "{}",
				headers: { authorization: "Bearer aws-sigv4" },
			},
		);
		expect(sent[0].headers.get("authorization")).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAFAKEFAKEFAKE1234\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, /,
		);
		expect(sent[0].headers.get("x-amz-security-token")).toBe("session");
		await expect(
			signed("https://api.openai.com/v1/responses", { body: "{}" }),
		).rejects.toThrow(/only sends requests to/);
	});
});

const sse = (events: object[]) =>
	new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);

describe("bedrock runtime request", () => {
	it("streams the Responses API on bedrock-runtime with effort, encrypted reasoning and a cache key, and reads cache stats", async () => {
		const requests: {
			url: string;
			headers: Headers;
			body: Record<string, unknown>;
		}[] = [];
		const fetch: typeof globalThis.fetch = async (url, init) => {
			requests.push({
				url: String(url),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			});
			const response = {
				id: "resp_1",
				object: "response",
				created_at: 1,
				model: "global.openai.gpt-6-luna",
				status: "completed",
				output: [],
				usage: {
					input_tokens: 1000,
					input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
					output_tokens: 50,
					output_tokens_details: { reasoning_tokens: 20 },
					total_tokens: 1050,
				},
			};
			return sse([
				{
					type: "response.created",
					sequence_number: 0,
					response: { ...response, status: "in_progress", usage: null },
				},
				{ type: "response.completed", sequence_number: 1, response },
			]);
		};
		const config = harborBridgeConfig({
			...bedrock,
			YTIMESY_HARBOR_MODEL: "openai.gpt-6-luna",
			YTIMESY_HARBOR_EFFORT: "high",
		});
		const runtime = await harborRuntime({
			config,
			env: {
				AWS_ACCESS_KEY_ID: FAKE_KEY,
				AWS_SECRET_ACCESS_KEY: FAKE_SECRET,
			},
			userId: "harbor",
			cacheScope: "trial-1",
			wrapModel: (model) => model,
			fetch,
		});
		expect(runtime.contextWindow).toBe(400_000);
		const result = streamText({
			model: runtime.model,
			prompt: "hi",
			...runtime.requestSettings?.("Be brief."),
		});
		const usage = await result.usage;
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request.url).toBe(
			"https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses",
		);
		expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
		expect(request.body).toMatchObject({
			model: "global.openai.gpt-6-luna",
			stream: true,
			instructions: "Be brief.",
			store: false,
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: "high" },
		});
		expect(request.body.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/);
		expect(usage.inputTokenDetails).toMatchObject({
			cacheReadTokens: 600,
			cacheWriteTokens: 300,
			noCacheTokens: 100,
		});
		// Luna on the global profile: 100 uncached, 600 read, 300 written, 50 out.
		expect(
			usageCostUsd(
				{
					inputTokens: 1000,
					outputTokens: 50,
					uncachedInputTokens: 100,
					cacheReadTokens: 600,
					cacheWriteTokens: 300,
				},
				config.billing,
			),
		).toBeCloseTo((100 * 0.1 + 600 * 0.01 + 300 * 0.125 + 50 * 0.5) / 1e6, 12);
	});
});

describe("spend ledger warnings", () => {
	it("writes one warning line each at 50% and 80% of the total cap", async () => {
		const { mkdtemp, readFile } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { reserveTrial, settleTrial, ledgerSummary } = await import(
			"../evals/harbor_v2/spend"
		);
		const ledger = `${await mkdtemp(`${tmpdir()}/ledger-`)}/l.jsonl`;
		const first = await reserveTrial({
			ledger,
			totalCapUsd: 10,
			trial: "a",
			trialCapUsd: 4,
		});
		expect(first.warnings).toEqual([]);
		const second = await reserveTrial({
			ledger,
			totalCapUsd: 10,
			trial: "b",
			trialCapUsd: 4,
		});
		expect(second.warnings).toEqual([
			"Spend ledger at 50% of its total cap: $8.00 committed of $10.",
			"Spend ledger at 80% of its total cap: $8.00 committed of $10.",
		]);
		const settled = await settleTrial({
			ledger,
			trial: "a",
			usd: 1,
			totalCapUsd: 10,
		});
		expect(settled.warnings).toEqual([]);
		const summary = await ledgerSummary(ledger);
		expect(summary.committedUsd).toBeCloseTo(5);
		expect(summary.warnings).toHaveLength(2);
		expect((await readFile(ledger, "utf8")).match(/"warning"/g)).toHaveLength(
			2,
		);
	});
});
