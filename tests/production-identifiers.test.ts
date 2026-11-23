import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	IDENTIFIER_FILES,
	liveProductionIdentifiers,
	type ProductionIdentifiers,
	supabaseRef,
	withProductionIdentifiers,
} from "../scripts/production-identifiers";

const ids: ProductionIdentifiers = {
	accountId: "a".repeat(32),
	hyperdrive: {
		webProduction: "b".repeat(32),
		edgeProduction: "c".repeat(32),
		development: "d".repeat(32),
	},
	productionRef: "p".repeat(20),
	developmentRef: "q".repeat(20),
};

describe("deploying from any chat: the real identifiers over the public placeholders", () => {
	it("fills every placeholder of the repository's own files, production ids inside env.production", () => {
		for (const file of IDENTIFIER_FILES) {
			const filled = withProductionIdentifiers(
				file,
				readFileSync(file, "utf8"),
				ids,
			);
			expect(filled).not.toMatch(
				/0{31}[01]|exampleprojectref|exampledevprojectref/,
			);
			if (file !== "scripts/deploy-production.ts") {
				const env = filled.slice(filled.indexOf('"env"'));
				expect(env).toContain(
					file === "wrangler.web.jsonc" ? "b".repeat(32) : "c".repeat(32),
				);
				expect(env).not.toContain("d".repeat(32));
			}
		}
	});

	it("refuses a file whose placeholder moved, instead of deploying without it", () => {
		expect(() =>
			withProductionIdentifiers("scripts/deploy-production.ts", "nothing", ids),
		).toThrow(/expected placeholder/);
	});

	it("reads the ids from the live Workers and refuses a development Worker on the production database", async () => {
		const origins: Record<string, string> = {
			web: "postgres.pppppppppppppppppppp",
			edge: "postgres.pppppppppppppppppppp",
			dev: "postgres.pppppppppppppppppppp",
		};
		const fake = (async (input: string) => {
			const path = new URL(input).pathname;
			const body = (result: unknown) =>
				new Response(JSON.stringify({ result }), { status: 200 });
			if (path.endsWith("/accounts")) return body([{ id: "acct" }]);
			const script =
				/scripts\/ytimesy-(web|edge-executor)-(production|development)/.exec(
					path,
				);
			if (script)
				return body({
					bindings: [
						{
							type: "hyperdrive",
							id:
								script[2] === "development"
									? "dev"
									: script[1] === "web"
										? "web"
										: "edge",
						},
					],
				});
			const config = /configs\/(\w+)$/.exec(path)?.[1] as string;
			return body({ origin: { user: origins[config] } });
		}) as unknown as typeof fetch;
		await expect(liveProductionIdentifiers("t", fake)).rejects.toThrow(
			/development Worker uses the production database/,
		);
		origins.dev = "postgres.qqqqqqqqqqqqqqqqqqqq";
		expect(await liveProductionIdentifiers("t", fake)).toEqual({
			accountId: "acct",
			hyperdrive: {
				webProduction: "web",
				edgeProduction: "edge",
				development: "dev",
			},
			productionRef: "p".repeat(20),
			developmentRef: "q".repeat(20),
		});
	});

	it("reads a Supabase ref from a pooler user or a direct host only", () => {
		expect(supabaseRef({ user: "postgres.abcdefghijabcdefghij" })).toBe(
			"abcdefghijabcdefghij",
		);
		expect(supabaseRef({ host: "db.abcdefghijabcdefghij.supabase.co" })).toBe(
			"abcdefghijabcdefghij",
		);
		expect(() => supabaseRef({ user: "postgres" })).toThrow();
	});
});
