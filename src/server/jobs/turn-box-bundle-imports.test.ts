import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The box's bundle is what `box-runner.ts` loads: its static imports (value
 * imports; type-only and dynamic `import()` do not load at startup). The box
 * holds no database URL, so a module in that bundle that imports a database
 * adapter DIRECTLY (one that itself imports `adapters/database`,
 * `database-scope` or `pg`) would query it by name at its first call and
 * fail on a box (docs/turn-runner-boxes.md, "Whole turn on a box").
 *
 * The list below is the debt as of this change, measured by this very walk
 * (54 -> 49 with the conversions of the same change: workspace
 * preparation, memory and push notices became ports, and `runApiTurn` loads
 * `localTurnPorts` only when no ports are given). The test fails when a NEW
 * module joins the bundle with such an import (convert it to a port, or
 * justify it here), and when an entry no longer applies (delete it:
 * the list may only shrink).
 *
 *  - "routed-off": the feature runs only for turns that routing keeps off
 *    boxes (helper chats, evaluation runs, subscription routes) or whose
 *    port throws on a box; the import is only loaded, not called.
 *  - "debt": loaded on a box and not yet a port. A plain answer or coding
 *    turn was run through the real `runApiTurn` over the fake edge with the
 *    database mocked to throw (box-turn-e2e.test.ts) and reached none of
 *    them; any other path may.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../..");

const BASELINE: Record<string, "routed-off" | "debt"> = {
	"server/jobs/api-turn.ts": "debt", // devEvalUsersEnabled (an env check in a database module)
	"server/services/y-squared-tools.ts": "routed-off",
	"server/services/queued-user-messages.ts": "debt", // the edge runs it at finalize; the loop imports it for y-squared/peer sends
	"server/services/harness-workspace-session.ts": "routed-off",
	"server/services/session-branch.ts": "debt",
	"server/auth/github-connection.ts": "debt",
	"server/services/codex-subscription-session.ts": "routed-off",
	"server/services/send-blockers.ts": "routed-off",
	"server/services/model-failover.ts": "debt", // planModelFailover on a failed model call
	"server/auth/codex-managed-auth.ts": "routed-off",
	"server/services/cancel-server-turn.ts": "routed-off",
	"server/services/turn-analytics.ts": "debt", // analyticsAgentRole only
	"server/jobs/conversation-delivery.ts": "debt",
	"server/services/agent-session-machine.ts": "routed-off", // the edge binds the machine (vm/ensure)
	"server/services/session-checkpoint.ts": "debt",
	"server/records/tools-snapshot-store.ts": "debt",
	"server/auth/codex-device-login.ts": "routed-off",
	"server/auth/agent-account.ts": "routed-off",
	"server/services/api-workspace-session.ts": "routed-off",
	"server/services/model-connections.ts": "debt", // connectionApiKey is never called on a box (grant-rotating fetch)
	"server/auth/xai-subscription.ts": "routed-off",
	"server/services/agent-mentions.ts": "debt", // withMentionNote reads sessions
	"server/services/subagent-tools.ts": "routed-off",
	"server/services/subagent-runtime.ts": "routed-off",
	"server/services/sidekick-classifier.ts": "routed-off",
	"server/services/api-agent-runtime.ts": "debt", // model-connections adapter (types and URL helpers)
	"server/services/agent-peer-messaging.ts": "routed-off",
	"server/jobs/queue.ts": "debt",
	"server/services/sidekick-model-switch.ts": "routed-off",
	"server/services/model-request-recorder.ts": "debt", // only for dev-eval users
	"server/services/mcp-oauth.ts": "routed-off", // a box runs with no MCP servers
	"server/services/machine-git.ts": "debt", // machineGitStep tokens (box has no git credentials)
	"server/services/journaled-tool-operation.ts": "debt",
	"server/services/fusion-lead.ts": "routed-off",
	"server/services/agent-task-event-delivery.ts": "routed-off",
	"server/services/fresh-machine-setup.ts": "debt",
	"server/services/project-environment-setup.ts": "debt",
	"server/services/code-mode-tool.ts": "debt",
	"server/services/claude-code-turn.ts": "routed-off",
	"server/services/workspace-desktop.ts": "debt",
	"server/services/agent-captures.ts": "debt",
	"server/services/pr-evidence.ts": "debt",
	"server/services/checker-pair-gate.ts": "routed-off",
	"server/services/background-command-notices.ts": "debt",
	"server/services/attempt-loop-deps.ts": "routed-off",
	"server/services/api-agent-tools.ts": "debt",
	"server/services/project-memory-tools.ts": "debt",
	"server/services/project-knowledge.ts": "debt", // recordCloudProjectReport is the edge's now
};

function resolveImport(from: string, specifier: string): string | null {
	const base = specifier.startsWith("#/")
		? resolve(SRC, specifier.slice(2))
		: specifier.startsWith(".")
			? resolve(dirname(from), specifier)
			: null;
	if (!base) return null;
	for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
		if (existsSync(candidate)) return candidate;
	return null;
}

function valueImports(file: string) {
	const text = readFileSync(file, "utf8");
	const found: string[] = [];
	for (const match of text.matchAll(
		/^(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+"([^"]+)"/gm,
	))
		found.push(match[1] as string);
	for (const match of text.matchAll(/^import\s+"([^"]+)"/gm))
		found.push(match[1] as string);
	return found;
}

const databaseFile = resolve(SRC, "server/adapters/database.ts");
const databaseModules = new Map<string, boolean>();
function reachesDatabase(file: string): boolean {
	const known = databaseModules.get(file);
	if (known !== undefined) return known;
	const direct =
		file === databaseFile ||
		file.endsWith("/server/adapters/database-scope.ts") ||
		valueImports(file).some((specifier) => {
			if (specifier === "pg" || specifier === "postgres") return true;
			const next = resolveImport(file, specifier);
			return (
				next === databaseFile ||
				Boolean(next?.endsWith("/server/adapters/database-scope.ts"))
			);
		});
	databaseModules.set(file, direct);
	return direct;
}

function boxBundleOffenders(entry: string) {
	const seen = new Set<string>();
	const offenders: string[] = [];
	const queue = [resolve(SRC, entry)];
	while (queue.length) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const specifiers = valueImports(file);
		const next = specifiers
			.map((specifier) => resolveImport(file, specifier))
			.filter((path): path is string => path !== null);
		// Adapters are the database side itself; what matters is who loads them.
		if (
			!file.includes("/server/adapters/") &&
			next.some((path) => path !== file && reachesDatabase(path))
		)
			offenders.push(file.slice(SRC.length + 1));
		queue.push(...next);
	}
	return { offenders: offenders.sort(), modules: seen.size, seen };
}

describe("the box bundle's database imports", () => {
	const { offenders, modules, seen } = boxBundleOffenders(
		"server/jobs/box-runner.ts",
	);

	it("walked the real bundle", () => {
		expect(modules).toBeGreaterThan(100);
		expect([...seen].some((file) => file.endsWith("/jobs/api-turn.ts"))).toBe(
			true,
		);
	});

	it("never loads the database-backed local ports (they are a dynamic import in the Durable Object path)", () => {
		expect(
			[...seen].some((file) => file.endsWith("/jobs/turn-ports-local.ts")),
		).toBe(false);
	});

	it("has no module outside the documented list importing a database adapter directly", () => {
		expect(offenders.filter((file) => !(file in BASELINE))).toEqual([]);
	});

	it("lists only modules that still do (the list may only shrink)", () => {
		expect(
			Object.keys(BASELINE).filter((file) => !offenders.includes(file)),
		).toEqual([]);
	});

	it("keeps the box-side jobs files themselves free of direct database imports", () => {
		for (const entry of [
			"server/jobs/turn-box-ports.ts",
			"server/jobs/turn-box-client.ts",
			"server/jobs/box-secrets-guard.ts",
			"server/jobs/turn-box-workspace.ts",
		]) {
			const { offenders: own } = boxBundleOffenders(entry);
			expect(own.filter((file) => file.startsWith("server/jobs/"))).toEqual([]);
		}
	});
});
