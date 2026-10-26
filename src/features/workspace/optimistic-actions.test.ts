import {
	MutationObserver,
	type MutationObserverOptions,
	QueryClient,
	type QueryKey,
} from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { PublicModelConnection } from "#/domain/model-connection";
import type { TrainingConsent } from "#/domain/training-consent";
import type { VmNetworkPolicy } from "#/domain/vm-network-policy";
import type { PublicMcpServer } from "#/server/adapters/mcp-servers";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { mcpServerRemove, mcpServerToggle } = await import(
	"../sessions/mcp-servers"
);
const { modelConnectionRemove } = await import("../sessions/model-connections");
const { failoverSettingsSave } = await import(
	"../sessions/model-failover-settings"
);
const { pluginToggle, pluginUninstall } = await import("../sessions/plugins");
const { machineSizeSave } = await import("./machine-size-settings");
const { memoryClear, memoryEditSave } = await import("./memory-edit-save");
const { memoryModeChange } = await import("./memory-settings");
const { networkAccessSave } = await import("./network-access-settings");
const { chatRemoval, projectRemoval } = await import("./sidebar-removals");
const { projectTrainingChange, trainingConsentChange } = await import(
	"./training-consent-settings"
);

type Entries = readonly (readonly [QueryKey, unknown])[];

/**
 * One converted action: the cache before, the click, what shows before the
 * server answers, the server's answer, and what shows once it lands.
 */
type ActionCase = {
	readonly name: string;
	readonly before: Entries;
	readonly build: (
		client: QueryClient,
		server: (input: unknown) => Promise<unknown>,
	) => MutationObserverOptions<unknown, Error, never, unknown>;
	readonly variables: unknown;
	readonly optimistic: Entries;
	readonly answer: unknown;
	/** After success: the server's answer, or the optimistic value marked stale. */
	readonly after: Entries;
	readonly refetched?: readonly QueryKey[];
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function seeded(entries: Entries) {
	const client = new QueryClient();
	for (const [key, data] of entries) client.setQueryData(key, data);
	return client;
}

function deferredServer() {
	const pending: {
		input: unknown;
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
	}[] = [];
	const call = (input: unknown) =>
		new Promise<unknown>((resolve, reject) => {
			pending.push({ input, resolve, reject });
		});
	return { pending, call };
}

const server = (
	id: string,
	enabled: boolean,
	pluginId: string | null = null,
): PublicMcpServer => ({
	id,
	name: id,
	url: `https://${id}.example.com/mcp`,
	headerNames: [],
	projectId: null,
	pluginId,
	enabled,
	auth: "headers",
	signIn: null,
});

const connection = (id: string): PublicModelConnection => ({
	id,
	provider: "openai",
	label: id,
	baseUrl: "https://api.openai.com/v1",
	models: [],
	revision: "1",
});

const consent = (enabled: boolean): TrainingConsent => ({
	enabled,
	policyVersion: enabled ? "2026-10-01" : null,
	changedAt: enabled ? "2026-10-26T00:00:00Z" : null,
});

const failover = (enabled: boolean, order: string[]) => ({
	enabled,
	askBeforePaid: true,
	connections: order.map((key) => ({ key, label: key, kind: "key" as const })),
});

const policy: VmNetworkPolicy = {
	mode: "allowlist",
	domains: ["api.example.com"],
};

const installed = (enabled: boolean) => [
	{
		id: "p1",
		catalogId: "linear",
		pluginName: "linear",
		enabled,
		commands: [],
		skills: [],
		mcpServers: [],
	},
];

const memoryFiles = [
	{
		path: "tooling.md",
		content: "# Tooling\n\n- Use pnpm [added: 2026-10-02]\n- Uses Vitest\n",
	},
];
const usePnpm = { path: "tooling.md", line: 3, text: "Use pnpm" };

const cases: ActionCase[] = [
	{
		name: "machine size",
		before: [[["project-machine-size", "p"], "large"]],
		build: (client, call) => machineSizeSave(client, "p", call as never),
		variables: "small",
		optimistic: [[["project-machine-size", "p"], "small"]],
		answer: "small",
		after: [[["project-machine-size", "p"], "small"]],
	},
	{
		name: "use memory",
		before: [
			[["memory-mode"], { available: true, mode: "full" }],
			[["memory"], { available: true, mode: "full", files: [] }],
			[["memory-dreams"], null],
		],
		build: (client, call) => memoryModeChange(client, call as never),
		variables: false,
		optimistic: [[["memory-mode"], { available: true, mode: "off" }]],
		answer: undefined,
		after: [[["memory-mode"], { available: true, mode: "off" }]],
		refetched: [["memory-mode"], ["memory"], ["memory-dreams"]],
	},
	{
		name: "training consent",
		before: [[["training-consent"], consent(false)]],
		build: (client, call) => trainingConsentChange(client, call as never),
		variables: true,
		optimistic: [[["training-consent"], { ...consent(false), enabled: true }]],
		answer: consent(true),
		after: [[["training-consent"], consent(true)]],
	},
	{
		name: "project training exclusion",
		before: [[["project-training", "p"], { excluded: false }]],
		build: (client, call) => projectTrainingChange(client, "p", call as never),
		variables: true,
		optimistic: [[["project-training", "p"], { excluded: true }]],
		answer: { excluded: true },
		after: [[["project-training", "p"], { excluded: true }]],
	},
	{
		name: "failover order",
		before: [[["model-failover-settings"], failover(true, ["a", "b"])]],
		build: (client, call) => failoverSettingsSave(client, call as never),
		variables: failover(true, ["b", "a"]),
		optimistic: [[["model-failover-settings"], failover(true, ["b", "a"])]],
		answer: failover(true, ["b", "a"]),
		after: [[["model-failover-settings"], failover(true, ["b", "a"])]],
	},
	{
		name: "internet access",
		before: [[["project-network-access", "p"], { mode: "full", domains: [] }]],
		build: (client, call) => networkAccessSave(client, "p", call as never),
		variables: policy,
		optimistic: [[["project-network-access", "p"], policy]],
		answer: policy,
		after: [[["project-network-access", "p"], policy]],
	},
	{
		name: "MCP server switch",
		before: [[["mcp-servers"], [server("a", true), server("b", true)]]],
		build: (client, call) => mcpServerToggle(client, call as never),
		variables: { id: "a", enabled: false },
		optimistic: [[["mcp-servers"], [server("a", false), server("b", true)]]],
		answer: [server("a", false), server("b", true)],
		after: [[["mcp-servers"], [server("a", false), server("b", true)]]],
	},
	{
		name: "MCP server removal",
		before: [[["mcp-servers"], [server("a", true), server("b", true)]]],
		build: (client, call) => mcpServerRemove(client, call as never),
		variables: "a",
		optimistic: [[["mcp-servers"], [server("b", true)]]],
		answer: [server("b", true)],
		after: [[["mcp-servers"], [server("b", true)]]],
	},
	{
		name: "plugin switch",
		before: [
			[
				["plugins"],
				{ catalog: [], installed: installed(true), requestUrl: null },
			],
			[["mcp-servers"], []],
		],
		build: (client, call) => pluginToggle(client, call as never),
		variables: { id: "p1", enabled: false },
		optimistic: [
			[
				["plugins"],
				{ catalog: [], installed: installed(false), requestUrl: null },
			],
		],
		answer: installed(false),
		after: [
			[
				["plugins"],
				{ catalog: [], installed: installed(false), requestUrl: null },
			],
		],
		refetched: [["plugins"], ["mcp-servers"]],
	},
	{
		name: "plugin removal",
		before: [
			[
				["plugins"],
				{ catalog: [], installed: installed(true), requestUrl: null },
			],
			[["mcp-servers"], [server("own", true), server("linear", true, "p1")]],
		],
		build: (client, call) => pluginUninstall(client, call as never),
		variables: "p1",
		optimistic: [
			[["plugins"], { catalog: [], installed: [], requestUrl: null }],
			[["mcp-servers"], [server("own", true)]],
		],
		answer: [],
		after: [
			[["plugins"], { catalog: [], installed: [], requestUrl: null }],
			[["mcp-servers"], [server("own", true)]],
		],
		refetched: [["plugins"], ["mcp-servers"]],
	},
	{
		name: "API key removal",
		before: [[["model-connections"], [connection("a"), connection("b")]]],
		build: (client, call) => modelConnectionRemove(client, call as never),
		variables: "a",
		optimistic: [[["model-connections"], [connection("b")]]],
		answer: [connection("b")],
		after: [[["model-connections"], [connection("b")]]],
	},
	{
		name: "memory line edit",
		before: [
			[["memory"], { available: true, mode: "full", files: memoryFiles }],
		],
		build: (client, call) => memoryEditSave(client, call as never),
		variables: { op: "update", ref: usePnpm, text: "Use pnpm only" },
		optimistic: [
			[
				["memory"],
				{
					available: true,
					mode: "full",
					files: [
						{
							path: "tooling.md",
							content:
								"# Tooling\n\n- Use pnpm only [added: 2026-10-02]\n- Uses Vitest\n",
						},
					],
				},
			],
		],
		answer: { ok: true },
		after: [
			[
				["memory"],
				{
					available: true,
					mode: "full",
					files: [
						{
							path: "tooling.md",
							content:
								"# Tooling\n\n- Use pnpm only [added: 2026-10-02]\n- Uses Vitest\n",
						},
					],
				},
			],
		],
		refetched: [["memory"]],
	},
	{
		name: "memory line delete",
		before: [
			[["memory"], { available: true, mode: "full", files: memoryFiles }],
		],
		build: (client, call) => memoryEditSave(client, call as never),
		variables: { op: "delete", ref: usePnpm },
		optimistic: [
			[
				["memory"],
				{
					available: true,
					mode: "full",
					files: [
						{ path: "tooling.md", content: "# Tooling\n\n- Uses Vitest\n" },
					],
				},
			],
		],
		answer: { ok: true },
		after: [
			[
				["memory"],
				{
					available: true,
					mode: "full",
					files: [
						{ path: "tooling.md", content: "# Tooling\n\n- Uses Vitest\n" },
					],
				},
			],
		],
		refetched: [["memory"]],
	},
	{
		name: "delete all memory",
		before: [
			[["memory"], { available: true, mode: "full", files: memoryFiles }],
		],
		build: (client, call) => memoryClear(client, call as never),
		variables: undefined,
		optimistic: [[["memory"], { available: true, mode: "full", files: [] }]],
		answer: undefined,
		after: [[["memory"], { available: true, mode: "full", files: [] }]],
		refetched: [["memory"]],
	},
	{
		name: "chat delete",
		before: [
			[
				["agent-sessions", "p"],
				[{ id: "c1" }, { id: "c2" }],
			],
		],
		build: (client, call) => chatRemoval(client, call as never),
		variables: { projectId: "p", sessionId: "c1" },
		optimistic: [[["agent-sessions", "p"], [{ id: "c2" }]]],
		answer: { id: "c1" },
		after: [[["agent-sessions", "p"], [{ id: "c2" }]]],
		refetched: [["agent-sessions", "p"]],
	},
	{
		name: "project removal",
		before: [[["projects"], [{ id: "p1" }, { id: "p2" }]]],
		build: (client, call) => projectRemoval(client, call as never),
		variables: "p1",
		optimistic: [[["projects"], [{ id: "p2" }]]],
		answer: { id: "p1" },
		after: [[["projects"], [{ id: "p2" }]]],
		refetched: [["projects"]],
	},
];

function expectEntries(client: QueryClient, entries: Entries) {
	for (const [key, data] of entries)
		expect(client.getQueryData(key), JSON.stringify(key)).toEqual(data);
}

describe.each(cases)("$name", (action) => {
	async function clicked() {
		const client = seeded(action.before);
		const backend = deferredServer();
		const observer = new MutationObserver(
			client,
			action.build(client, backend.call) as MutationObserverOptions<
				unknown,
				Error,
				unknown,
				unknown
			>,
		);
		const done = observer.mutate(action.variables);
		await flush();
		return { client, backend, done };
	}

	it("shows the result before the server answers", async () => {
		const { client, backend } = await clicked();
		expect(backend.pending).toHaveLength(1);
		expectEntries(client, action.optimistic);
	});

	it("puts everything back when the server fails", async () => {
		const { client, backend, done } = await clicked();
		backend.pending[0].reject(new Error("Server down"));
		await expect(done).rejects.toThrow("Server down");
		expectEntries(client, action.before);
	});

	it("matches the server once it answers", async () => {
		const { client, backend, done } = await clicked();
		backend.pending[0].resolve(action.answer);
		await done;
		expectEntries(client, action.after);
		for (const key of action.refetched ?? [])
			expect(
				client.getQueryState(key)?.isInvalidated,
				JSON.stringify(key),
			).toBe(true);
	});
});

it("rolls back a memory edit the server refuses as stale", async () => {
	const client = seeded([
		[["memory"], { available: true, mode: "full", files: memoryFiles }],
	]);
	const observer = new MutationObserver(
		client,
		memoryEditSave(client, async () => ({
			ok: false as const,
			error: "That line changed. Reload memory.",
		})),
	);
	await expect(observer.mutate({ op: "delete", ref: usePnpm })).rejects.toThrow(
		"That line changed.",
	);
	expect(client.getQueryData(["memory"])).toEqual({
		available: true,
		mode: "full",
		files: memoryFiles,
	});
});

it("a rename-then-delete style pair on one list ends as the server says", async () => {
	const client = seeded([
		[
			["agent-sessions", "p"],
			[{ id: "c1" }, { id: "c2" }, { id: "c3" }],
		],
	]);
	const backend = deferredServer();
	const first = new MutationObserver(client, chatRemoval(client, backend.call));
	const second = new MutationObserver(
		client,
		chatRemoval(client, backend.call),
	);
	const one = first.mutate({ projectId: "p", sessionId: "c1" });
	const two = second.mutate({ projectId: "p", sessionId: "c2" });
	await flush();
	expect(client.getQueryData(["agent-sessions", "p"])).toEqual([{ id: "c3" }]);
	backend.pending[0].resolve({ id: "c1" });
	await one;
	// The first answer does not refetch while the second delete is running.
	expect(client.getQueryState(["agent-sessions", "p"])?.isInvalidated).toBe(
		false,
	);
	await flush();
	backend.pending[1].reject(new Error("down"));
	await expect(two).rejects.toThrow();
	expect(client.getQueryData(["agent-sessions", "p"])).toEqual([
		{ id: "c2" },
		{ id: "c3" },
	]);
	expect(client.getQueryState(["agent-sessions", "p"])?.isInvalidated).toBe(
		true,
	);
});
