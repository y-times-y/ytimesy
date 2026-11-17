import { describe, expect, it, vi } from "vitest";
import { fakeEdge } from "../edge/turn-box-fake-edge";
import { runTurnRunnerBox } from "./box-runner";
import {
	assertTurnBoxHoldsNoSecrets,
	TurnBoxHoldsSecrets,
	turnBoxForbiddenEnv,
} from "./box-secrets-guard";
import { TurnBoxEdgeClient } from "./turn-box-client";

const CLEAN = {
	YTIMESY_EDGE_URL: "https://edge.test",
	YTIMESY_BOX_IDENTITY: "ytbi1.x.y",
	YTIMESY_MODEL_EXECUTION_TARGET: "durable-object",
	TURN_BOX_EDGE_PUBLIC_KEY: "public",
	PATH: "/usr/bin",
	HOME: "/home/box",
};

describe("a box with secrets refuses to run", () => {
	it("accepts an environment with only the box's identity and the edge URL", () => {
		expect(turnBoxForbiddenEnv(CLEAN)).toEqual([]);
		expect(() => assertTurnBoxHoldsNoSecrets(CLEAN)).not.toThrow();
	});

	it("names (never prints the values of) the database URL, provider keys and vault keys", () => {
		const env = {
			...CLEAN,
			DATABASE_URL: "postgres://user:hunter2@db/prod",
			OPENAI_API_KEY: "sk-live-1",
			ANTHROPIC_API_KEY: "sk-ant-1",
			GOOGLE_GENERATIVE_AI_API_KEY: "g-1",
			OPENROUTER_API_KEY: "or-1",
			TOKEN_VAULT_KEY: "vault-1",
			FREESTYLE_API_KEY: "fs-1",
			GITHUB_APP_PRIVATE_KEY: "pem",
			TURN_BOX_EDGE_PRIVATE_KEY: "ed-private",
			SOME_NEW_PROVIDER_API_KEY: "future",
		};
		const names = turnBoxForbiddenEnv(env);
		expect(names).toEqual(
			[
				"ANTHROPIC_API_KEY",
				"DATABASE_URL",
				"FREESTYLE_API_KEY",
				"GITHUB_APP_PRIVATE_KEY",
				"GOOGLE_GENERATIVE_AI_API_KEY",
				"OPENAI_API_KEY",
				"OPENROUTER_API_KEY",
				"SOME_NEW_PROVIDER_API_KEY",
				"TOKEN_VAULT_KEY",
				"TURN_BOX_EDGE_PRIVATE_KEY",
			].sort(),
		);
		let thrown: unknown;
		try {
			assertTurnBoxHoldsNoSecrets(env);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(TurnBoxHoldsSecrets);
		const message = (thrown as Error).message;
		expect(message).toContain("DATABASE_URL");
		for (const value of ["hunter2", "sk-live-1", "vault-1", "ed-private"])
			expect(message).not.toContain(value);
	});

	it("ignores variables that are set but empty", () => {
		expect(
			turnBoxForbiddenEnv({ ...CLEAN, DATABASE_URL: "", OPENAI_API_KEY: " " }),
		).toEqual([]);
	});

	it("fails the box's startup before it claims anything", async () => {
		const claim = vi.fn();
		const client = { claim, register: vi.fn() } as unknown as TurnBoxEdgeClient;
		await expect(
			runTurnRunnerBox({
				env: { ...CLEAN, DATABASE_URL: "postgres://x" },
				client,
				machines: {} as never,
				signalHandlers: false,
			}),
		).rejects.toBeInstanceOf(TurnBoxHoldsSecrets);
		await expect(
			runTurnRunnerBox({
				env: { ...CLEAN, OPENAI_API_KEY: "sk" },
				client,
				machines: {} as never,
				signalHandlers: false,
			}),
		).rejects.toBeInstanceOf(TurnBoxHoldsSecrets);
		expect(claim).not.toHaveBeenCalled();
		expect(client.register).not.toHaveBeenCalled();
	});

	it("needs the edge URL and its identity, and no database", async () => {
		await expect(
			runTurnRunnerBox({
				env: { YTIMESY_MODEL_EXECUTION_TARGET: "durable-object" },
				machines: {} as never,
			}),
		).rejects.toThrow(/YTIMESY_EDGE_URL/);
	});

	it("claims through the edge's claim endpoint and registers through the edge, never a database", async () => {
		const edge = await fakeEdge();
		const paths: string[] = [];
		const client = new TurnBoxEdgeClient({
			edgeUrl: "https://edge.test",
			identity: edge.identity,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				paths.push(new URL(String(input)).pathname);
				return edge.fetchEdge(input, init);
			}) as typeof fetch,
			now: () => edge.state.now,
		});
		const box = await runTurnRunnerBox({
			env: { ...CLEAN, YTIMESY_MODEL_EXECUTION_TARGET: "durable-object" },
			client,
			machines: {} as never,
			signalHandlers: false,
		});
		await box.dispatcher.drain();
		expect(paths).toContain("/box/v1/register");
		expect(paths).toContain("/box/v1/claim");
		// Everything the box did was a call to the edge.
		expect(paths.every((path) => path.startsWith("/box/v1/"))).toBe(true);
		expect(edge.calls).toContain("claim");
	});
});
