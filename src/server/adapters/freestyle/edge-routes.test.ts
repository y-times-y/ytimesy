import type { Freestyle } from "freestyle";
import { expect, it, vi } from "vitest";
import {
	listVmEdgeRoutes,
	publishVmEdgeRoute,
	withdrawVmEdgeRoutes,
} from "./edge-routes";

type Rule = {
	id: string;
	domain: string;
	source: { public?: true; vmId?: string };
	destination: { vmId?: string; port?: number };
	forwardAuth?: { id: string };
};

function fakeFreestyle(initial: Rule[]) {
	const rules = [...initial];
	let next = 0;
	const tls = {
		list: vi.fn(async () => ({ rules: [...rules], totalCount: rules.length })),
		create: vi.fn(async (rule: Omit<Rule, "id">) => {
			const created = { ...rule, id: `new-${next++}` };
			rules.push(created);
			return created;
		}),
		update: vi.fn(async (id: string, rule: Omit<Rule, "id">) => {
			const index = rules.findIndex((current) => current.id === id);
			rules[index] = { ...rule, id };
			return rules[index];
		}),
		delete: vi.fn(async (id: string) => {
			const index = rules.findIndex((current) => current.id === id);
			if (index < 0) throw Object.assign(new Error("gone"), { status: 404 });
			rules.splice(index, 1);
		}),
	};
	return {
		freestyle: { tls: { rules: tls } } as unknown as Freestyle,
		rules,
		tls,
	};
}

const route = (id: string, domain: string, port: number): Rule => ({
	id,
	domain,
	source: { public: true },
	destination: { vmId: "vm-1", port },
});

it("lists only our public routes", async () => {
	const { freestyle } = fakeFreestyle([
		route("a", "ytimesy-desk-x.style.dev", 6080),
		route("b", "customer.example.com", 3000),
		{
			id: "c",
			domain: "api.internal",
			source: { vmId: "vm-2" },
			destination: { vmId: "vm-1", port: 80 },
		},
	]);
	expect(await listVmEdgeRoutes(freestyle, "vm-1")).toEqual([
		{
			ruleId: "a",
			domain: "ytimesy-desk-x.style.dev",
			port: 6080,
			forwardAuthId: null,
		},
	]);
});

it("publishes once, replacing a legacy desktop route and keeping unrelated ones", async () => {
	const { freestyle, rules, tls } = fakeFreestyle([
		route("legacy", "ytimesy-desk-abc123.style.dev", 6080),
		route("preview", "ytimesy-pv-x-3000.style.dev", 3000),
	]);
	const wanted = { hostname: "ytimesy-desk-keyed.style.dev", port: 6080 };
	expect(await publishVmEdgeRoute(freestyle, "vm-1", wanted)).toEqual({
		origin: "https://ytimesy-desk-keyed.style.dev",
		ruleId: "new-0",
	});
	expect(rules.map((rule) => rule.id)).toEqual(["preview", "new-0"]);
	await publishVmEdgeRoute(freestyle, "vm-1", wanted);
	expect(tls.create).toHaveBeenCalledOnce();
});

it("adds or drops forward auth in place, keeping the rule id", async () => {
	const { freestyle, rules } = fakeFreestyle([
		route("pv", "ytimesy-pv-x-3000.style.dev", 3000),
	]);
	const published = await publishVmEdgeRoute(freestyle, "vm-1", {
		hostname: "ytimesy-pv-x-3000.style.dev",
		port: 3000,
		forwardAuthId: "fa-1",
	});
	expect(published.ruleId).toBe("pv");
	expect(rules[0]?.forwardAuth).toEqual({ id: "fa-1" });
});

it("withdraws our routes by kind and port, tolerating ones already gone", async () => {
	const { freestyle, rules } = fakeFreestyle([
		route("desk", "ytimesy-desk-x.style.dev", 6080),
		route("pv3000", "ytimesy-pv-x-3000.style.dev", 3000),
		route("pv5173", "ytimesy-pv-x-5173.style.dev", 5173),
		route("share", "ytimesy-share-x-3000.style.dev", 3000),
		route("theirs", "customer.example.com", 3000),
	]);
	expect(await withdrawVmEdgeRoutes(freestyle, "vm-1", ["share"], 3000)).toBe(
		1,
	);
	expect(
		await withdrawVmEdgeRoutes(freestyle, "vm-1", ["desk", "tools", "pv"]),
	).toBe(3);
	expect(rules.map((rule) => rule.id)).toEqual(["theirs"]);
});
