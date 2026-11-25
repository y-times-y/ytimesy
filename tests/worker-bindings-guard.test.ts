import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	liveWorkerBindingProblems,
	missingRequiredBindings,
	REQUIRED_PRODUCTION_BINDINGS,
} from "../scripts/worker-bindings-guard";

const egress = {
	name: "CODEX_EGRESS",
	type: "vpc_network",
	network_id: "cf1:network",
};

it("refuses a Worker that lost, retyped or re-pointed CODEX_EGRESS", () => {
	const script = "ytimesy-web-production";
	expect(missingRequiredBindings(script, [egress])).toEqual([]);
	expect(missingRequiredBindings(script, [])[0]).toContain("no CODEX_EGRESS");
	// What Alchemy does to a binding it cannot express: a JSON variable.
	expect(
		missingRequiredBindings(script, [
			{ name: "CODEX_EGRESS", type: "json" },
		])[0],
	).toContain("not vpc_network");
	expect(
		missingRequiredBindings(script, [
			{ ...egress, network_id: "cf1:other" },
		])[0],
	).toContain("cf1:other");
});

it("reads both live production Workers and reports the one missing the binding", async () => {
	const fetcher = (async (url: string | URL | Request) => {
		const path = String(url);
		const result = path.endsWith("/accounts")
			? [{ id: "acct" }]
			: { bindings: path.includes("edge-executor") ? [egress] : [] };
		return Response.json({ result });
	}) as typeof fetch;
	const problems = await liveWorkerBindingProblems("token", fetcher);
	expect(problems).toHaveLength(1);
	expect(problems[0]).toContain("ytimesy-web-production");
});

it("is declared by both wrangler configs and by the Alchemy stack, so a deploy of any kind carries it", () => {
	for (const file of ["wrangler.web.jsonc", "wrangler.edge-executor.jsonc"]) {
		const text = readFileSync(file, "utf8");
		const production = text.slice(text.indexOf('"production"'));
		expect(production, file).toContain('"binding": "CODEX_EGRESS"');
		expect(production, file).toContain('"network_id": "cf1:network"');
	}
	const stack = readFileSync("infra/alchemy/cloudflare.run.ts", "utf8");
	expect(stack.match(/CODEX_EGRESS: codexEgress/g)).toHaveLength(2);
	expect(stack).toContain('{ type: "vpc_network", networkId: "cf1:network" }');
	expect(Object.keys(REQUIRED_PRODUCTION_BINDINGS)).toHaveLength(2);
});
