import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	productionBuildId,
	productionSmokeChecks,
	runSmokeChecks,
	type SmokeResponse,
} from "../scripts/production-smoke-check";

const buildId = "f3f620dd1a2b-mhjk2l0";
const page = (build: string | null, body?: string): SmokeResponse => ({
	status: 200,
	headers: new Headers({
		"content-type": "text/html; charset=utf-8",
		...(build ? { "x-ytimesy-build": build } : {}),
	}),
	body:
		body ??
		"<!DOCTYPE html><html><head><title>ytimesy: AI software engineer in the cloud</title></head></html>",
});
const json = (value: unknown, status = 200): SmokeResponse => ({
	status,
	headers: new Headers({ "content-type": "application/json" }),
	body: JSON.stringify(value),
});

const checks = productionSmokeChecks({
	appUrl: "https://ytimesy.com",
	edgeUrl: "https://edge.ytimesy.com",
	buildId,
});
const named = (name: string) => {
	const check = checks.find((row) => row.name === name);
	if (!check) throw new Error(`no ${name} check`);
	return check;
};

it("names each deploy's build by commit and time", () => {
	expect(productionBuildId("f3f620dd1a2b3c4d5e6f\n", 1_762_000_000_000)).toBe(
		`f3f620dd1a2b-${(1_762_000_000_000).toString(36)}`,
	);
});

it("checks the home page, the web's build and the edge's health", () => {
	expect(checks.map((check) => [check.name, check.url])).toEqual([
		["web home page", "https://ytimesy.com/"],
		["web version", "https://ytimesy.com/api/version"],
		["edge health", "https://edge.ytimesy.com/health"],
	]);
	// Before go-live the web has no public route: only the edge is checked.
	expect(
		productionSmokeChecks({
			appUrl: null,
			edgeUrl: "https://edge.ytimesy.com",
			buildId,
		}).map((check) => check.name),
	).toEqual(["edge health"]);
});

it("passes only the new build's real page and versions", () => {
	const home = named("web home page");
	expect(home.problem(page(buildId))).toBeNull();
	expect(home.problem(page("older"))).toBe(
		`page is build older, not ${buildId}`,
	);
	expect(home.problem({ ...page(buildId), status: 500 })).toBe("answered 500");
	expect(
		home.problem(page(buildId, "<!DOCTYPE html><title>Error</title>")),
	).toBe("answered without the ytimesy page title");
	expect(home.problem(json({ build: buildId }))).toBe("answered without HTML");
	for (const name of ["web version", "edge health"]) {
		const check = named(name);
		expect(check.problem(json({ build: buildId }))).toBeNull();
		expect(check.problem(json({ build: "older" }))).toBe(
			`serves build older, not ${buildId}`,
		);
		expect(check.problem(json(null, 503))).toBe("answered 503");
		expect(check.problem({ ...page(buildId), body: "<html>" })).toBe(
			"answered without JSON",
		);
	}
});

it("retries failing checks, then reports what still fails", async () => {
	const answers: Record<string, SmokeResponse[]> = {
		"https://ytimesy.com/": [page("older"), page(buildId)],
		"https://ytimesy.com/api/version": [json({ build: buildId })],
		"https://edge.ytimesy.com/health": [json(null, 503), json(null, 503)],
	};
	const asked: string[] = [];
	const slept: number[] = [];
	const problems = await runSmokeChecks(
		checks,
		async (url) => {
			asked.push(url);
			const next = answers[url].shift();
			if (!next) throw new TypeError("fetch failed");
			return next;
		},
		{ attempts: 3, delayMs: 10_000, sleep: async (ms) => slept.push(ms) },
	);
	// Passing checks are not asked again.
	expect(asked.filter((url) => url.endsWith("/api/version"))).toHaveLength(1);
	expect(slept).toEqual([10_000, 10_000]);
	expect(problems).toEqual([
		"edge health (https://edge.ytimesy.com/health): unreachable (TypeError)",
	]);
});

it("passes as soon as every check does", async () => {
	const slept: number[] = [];
	expect(
		await runSmokeChecks(
			checks,
			async (url) =>
				url.endsWith("/") ? page(buildId) : json({ build: buildId }),
			{ attempts: 7, delayMs: 10_000, sleep: async (ms) => slept.push(ms) },
		),
	).toEqual([]);
	expect(slept).toEqual([]);
});

it("the production deploy smoke-checks and rolls back what it deployed", () => {
	const script = readFileSync("scripts/deploy-production.ts", "utf8");
	expect(script).toContain("runSmokeChecks(");
	expect(script).toContain("rollbackStep(");
	expect(script).toContain("process.env.YTIMESY_BUILD_ID = buildId");
});
