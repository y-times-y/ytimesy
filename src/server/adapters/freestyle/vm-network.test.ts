import { describe, expect, it } from "vitest";
import { applyVmNetworkPolicy, platformEgressDomains } from "./vm-network";

function fakeRules(input: {
	firewall?: { id: string; source: object; destination: object }[];
	tls?: {
		id: string;
		domain: string;
		source: object;
		destination: object;
		protocol: string;
		transform?: unknown[];
	}[];
}) {
	const calls: string[] = [];
	let next = 0;
	const freestyle = {
		firewall: {
			rules: {
				list: async () => ({ rules: input.firewall ?? [], totalCount: 0 }),
				create: async (rule: { destination: object }) => {
					calls.push(`fw+ ${JSON.stringify(rule.destination)}`);
					return { id: `fw-${next++}` };
				},
				delete: async (id: string) => {
					calls.push(`fw- ${id}`);
				},
			},
		},
		tls: {
			rules: {
				list: async () => ({ rules: input.tls ?? [], totalCount: 0 }),
				create: async (rule: { domain: string; source: { vmId: string } }) => {
					calls.push(`tls+ ${rule.domain} ${rule.source.vmId}`);
					return { id: `tls-${next++}` };
				},
				delete: async (id: string) => {
					calls.push(`tls- ${id}`);
				},
			},
		},
	};
	return { freestyle: freestyle as never, calls };
}

const publicGrant = {
	id: "fw-public",
	source: { vmId: "vm-1" },
	destination: { public: true },
};

describe("applyVmNetworkPolicy", () => {
	it("restricting adds grants first, then drops the public firewall grant", async () => {
		const { freestyle, calls } = fakeRules({ firewall: [publicGrant] });
		await applyVmNetworkPolicy(
			freestyle,
			"vm-1",
			{ mode: "allowlist", domains: ["example.com"] },
			["git.proxy.dev"],
		);
		expect(calls).toEqual([
			"tls+ example.com vm-1",
			"tls+ git.proxy.dev vm-1",
			"fw- fw-public",
		]);
	});
	it("is a no-op when already in place", async () => {
		const { freestyle, calls } = fakeRules({
			tls: [
				{
					id: "t1",
					domain: "example.com",
					source: { vmId: "vm-1" },
					destination: { public: true },
					protocol: "http",
				},
			],
		});
		await applyVmNetworkPolicy(
			freestyle,
			"vm-1",
			{ mode: "allowlist", domains: ["example.com"] },
			[],
		);
		expect(calls).toEqual([]);
	});
	it("full restores the public grant and removes passthrough rules but not edge routes or transforms", async () => {
		const { freestyle, calls } = fakeRules({
			tls: [
				{
					id: "t1",
					domain: "example.com",
					source: { vmId: "vm-1" },
					destination: { public: true },
					protocol: "http",
				},
				{
					id: "route",
					domain: "x.style.dev",
					source: { public: true },
					destination: { vmId: "vm-1" },
					protocol: "http",
				},
				{
					id: "secret",
					domain: "api.x.com",
					source: { vmId: "vm-1" },
					destination: { public: true },
					protocol: "http",
					transform: [{}],
				},
			],
		});
		await applyVmNetworkPolicy(
			freestyle,
			"vm-1",
			{ mode: "full", domains: [] },
			[],
		);
		expect(calls).toEqual(['fw+ {"public":true}', "tls- t1"]);
	});
	it("ignores a port-scoped public firewall rule", async () => {
		const { freestyle, calls } = fakeRules({
			firewall: [
				{
					id: "fw-443",
					source: { vmId: "vm-1" },
					destination: { public: true, port: 443, protocol: "tcp" },
				},
			],
		});
		await applyVmNetworkPolicy(
			freestyle,
			"vm-1",
			{ mode: "allowlist", domains: [] },
			[],
		);
		expect(calls).toEqual([]);
	});
});

it("grants the git proxy host in restricted modes", () => {
	expect(
		platformEgressDomains({
			YTIMESY_GIT_PROXY_URL: "https://git.example.dev/",
		}),
	).toEqual(["git.example.dev"]);
	expect(platformEgressDomains({})).toEqual([]);
});
