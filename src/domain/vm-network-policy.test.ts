import { describe, expect, it } from "vitest";
import {
	DEFAULT_ALLOWED_DOMAINS,
	normalizeAllowedDomain,
	parseDomainList,
	vmEgressPlan,
	vmNetworkPolicy,
} from "./vm-network-policy";

describe("vmEgressPlan", () => {
	it("full keeps the open internet and no TLS rules", () => {
		expect(
			vmEgressPlan({ mode: "full", domains: ["a.com"] }, ["git.x.dev"]),
		).toEqual({
			publicFirewall: true,
			tlsDomains: [],
		});
	});
	it("allowlist grants only the project's domains plus the platform's", () => {
		expect(
			vmEgressPlan({ mode: "allowlist", domains: ["example.com"] }, [
				"git.x.dev",
			]),
		).toEqual({
			publicFirewall: false,
			tlsDomains: ["example.com", "git.x.dev"],
		});
	});
	it("defaults adds the built-in list, deduplicated", () => {
		const plan = vmEgressPlan({
			mode: "defaults",
			domains: ["pypi.org", "my.dev"],
		});
		expect(plan.publicFirewall).toBe(false);
		expect(plan.tlsDomains).toContain("pypi.org");
		expect(plan.tlsDomains).toContain("registry.npmjs.org");
		expect(plan.tlsDomains).toContain("my.dev");
		expect(new Set(plan.tlsDomains).size).toBe(plan.tlsDomains.length);
	});
	it("built-in domains are all valid rule names", () => {
		for (const domain of DEFAULT_ALLOWED_DOMAINS)
			expect(normalizeAllowedDomain(domain)).toBe(domain);
	});
});

describe("domain validation", () => {
	it.each([
		["Example.COM.", "example.com"],
		["*.example.com", "*.example.com"],
		[" api.example.com ", "api.example.com"],
	])("accepts %s", (input, output) => {
		expect(normalizeAllowedDomain(input)).toBe(output);
	});
	it.each([
		"*",
		"*.com",
		"localhost",
		"10.0.0.1",
		"https://example.com",
		"a.*.example.com",
		"**.example.com",
		"-bad.example.com",
		"exa mple.com",
	])("rejects %s", (input) => {
		expect(normalizeAllowedDomain(input)).toBeNull();
	});
	it("policy parse normalizes, dedupes and reports bad entries", () => {
		expect(
			vmNetworkPolicy.parse({ mode: "allowlist", domains: ["A.com", "a.com"] }),
		).toEqual({ mode: "allowlist", domains: ["a.com"] });
		const bad = vmNetworkPolicy.safeParse({
			mode: "allowlist",
			domains: ["no"],
		});
		expect(bad.success).toBe(false);
		expect(
			vmNetworkPolicy.safeParse({ mode: "open", domains: [] }).success,
		).toBe(false);
		expect(
			vmNetworkPolicy.safeParse({
				mode: "allowlist",
				domains: Array.from({ length: 51 }, (_, i) => `d${i}.com`),
			}).success,
		).toBe(false);
	});
	it("splits the textarea on lines, commas and spaces", () => {
		expect(parseDomainList("a.com\n b.com, c.com\n\n")).toEqual([
			"a.com",
			"b.com",
			"c.com",
		]);
	});
});
