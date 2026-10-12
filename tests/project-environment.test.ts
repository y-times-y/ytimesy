import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	ResumeLater,
	resumableCommand,
} from "../src/server/adapters/resumable-commands";
import { durableObjectState } from "./support/durable-object-state";

const build = vi.hoisted(() => ({
	resolveEnvironmentBuildInput: vi.fn(),
	claimEnvironmentBuild: vi.fn(),
	provisionEnvironmentBuild: vi.fn(),
	prepareEnvironmentRepositories: vi.fn(),
	verifyEnvironmentRepositories: vi.fn(),
	activateEnvironmentBuild: vi.fn(),
	finishEnvironmentBuild: vi.fn(),
	failEnvironmentPreflight: vi.fn(),
	assertDistinctEnvironmentServicePorts: vi.fn(),
}));
const vmExec = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));
vi.mock("../src/server/adapters/database-scope", () => ({
	withDatabaseScope: async (_url: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../src/server/edge/model-endpoint", () => ({
	withEdgeModelEndpoints: (run: () => Promise<unknown>) => run(),
}));
vi.mock("../src/server/adapters/freestyle/workspace-runtime", () => ({
	workspaceRuntimeFromEnv: () => ({ exec: vmExec, pause: vi.fn() }),
}));
vi.mock("../src/server/services/environment-build", () => build);

import { ProjectEnvironment } from "../src/server/edge/project-environment";

const workspaceId = "00000000-0000-4000-8000-000000000002";
const request = {
	requestId: "00000000-0000-4000-8000-000000000001",
	workspaceId,
	force: false,
	repairModel: null,
};
function fixture() {
	const state = durableObjectState();
	const object = new ProjectEnvironment(
		state.ctx as never,
		{
			DATABASE_URL: "fixture",
			HYPERDRIVE: { connectionString: "fixture" },
			CODEX_EGRESS: { fetch: vi.fn() },
			YTIMESY_GIT_PROXY_URL: "https://fixture.invalid",
			YTIMESY_GIT_PROXY_SECRET: "x".repeat(32),
		} as never,
	);
	const requestState = () =>
		state.ctx.storage.sql
			.exec("select state from environment_request")
			.toArray()[0]?.state;
	return { object, state, requestState };
}
async function runAlarm(object: ProjectEnvironment) {
	const pending = object.alarm();
	await vi.runAllTimersAsync();
	await pending;
}
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout"] });
	build.resolveEnvironmentBuildInput.mockResolvedValue({
		workspaceId,
		repositories: [{ fullName: "org/repo" }],
	});
	build.claimEnvironmentBuild.mockResolvedValue("build");
	build.provisionEnvironmentBuild.mockResolvedValue("vm");
	build.prepareEnvironmentRepositories.mockImplementation(
		async (input) => input.repositories,
	);
	build.verifyEnvironmentRepositories.mockResolvedValue([]);
	build.activateEnvironmentBuild.mockResolvedValue("snapshot");
	build.finishEnvironmentBuild.mockResolvedValue(undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.resetAllMocks();
});

it("runs a build once per request and checks shared ports before activation", async () => {
	const { object, state, requestState } = fixture();
	build.resolveEnvironmentBuildInput.mockResolvedValue({
		workspaceId,
		repositories: [{ fullName: "org/web" }, { fullName: "org/api" }],
	});
	await object.start(request);
	await object.start(request);
	expect(state.alarm.at).not.toBeNull();
	await runAlarm(object);
	expect(build.prepareEnvironmentRepositories).toHaveBeenCalledTimes(2);
	expect(build.assertDistinctEnvironmentServicePorts).toHaveBeenCalledWith([
		{ fullName: "org/web" },
		{ fullName: "org/api" },
	]);
	expect(build.activateEnvironmentBuild).toHaveBeenCalledOnce();
	expect(build.finishEnvironmentBuild).toHaveBeenCalledOnce();
	expect(requestState()).toBe("done");
	await object.start(request);
	expect(requestState()).toBe("done");
});

it("continues a long install across alarms, replaying finished commands and re-attaching to the running one", async () => {
	const commandIds: string[] = [];
	vmExec.mockImplementation(async (_vm, argv) => {
		commandIds.push(resumableCommand()?.commandId ?? "");
		if (argv[0] === "install" && commandIds.length === 2)
			throw new ResumeLater();
		return { exitCode: 0, stdout: argv[0], stderr: "" };
	});
	build.prepareEnvironmentRepositories.mockImplementation(
		async (input, vm, runtime) => {
			await runtime.exec(vm, ["clone"], {}, 600_000);
			await runtime.exec(vm, ["install"], {}, 3_600_000);
			return input.repositories;
		},
	);
	const { object, state, requestState } = fixture();
	await object.start(request);
	await runAlarm(object);
	expect(requestState()).toBe("running");
	expect(build.finishEnvironmentBuild).not.toHaveBeenCalled();
	expect(state.alarm.at).not.toBeNull();
	await runAlarm(object);
	expect(requestState()).toBe("done");
	// clone ran once; install was re-attached under the same command ID.
	expect(vmExec.mock.calls.map((call) => call[1][0])).toEqual([
		"clone",
		"install",
		"install",
	]);
	expect(commandIds[1]).toBe(commandIds[2]);
	expect(build.provisionEnvironmentBuild).toHaveBeenCalledOnce();
	expect(build.claimEnvironmentBuild).toHaveBeenCalledOnce();
	expect(build.activateEnvironmentBuild).toHaveBeenCalledOnce();
});

it("fails closed when a side-effecting stage was interrupted", async () => {
	const { object, state } = fixture();
	await object.start(request);
	state.ctx.storage.sql.exec(
		"insert into environment_stage values(?,'resolve-authorized-sources','done',?)",
		request.requestId,
		JSON.stringify({ workspaceId, repositories: [] }),
	);
	state.ctx.storage.sql.exec(
		"insert into environment_stage values(?,'claim-build','done','\"build\"')",
		request.requestId,
	);
	state.ctx.storage.sql.exec(
		"insert into environment_stage values(?,'activate-snapshot','started',null)",
		request.requestId,
	);
	await runAlarm(object);
	expect(build.activateEnvironmentBuild).not.toHaveBeenCalled();
	expect(build.finishEnvironmentBuild).toHaveBeenCalledOnce();
});

it("cleans up a failed installation without activating it, retrying transient cleanup", async () => {
	build.prepareEnvironmentRepositories.mockRejectedValue(
		new Error("install failed"),
	);
	build.finishEnvironmentBuild.mockRejectedValueOnce(
		new Error("pause unavailable"),
	);
	const { object, requestState } = fixture();
	await object.start(request);
	await runAlarm(object);
	expect(build.activateEnvironmentBuild).not.toHaveBeenCalled();
	expect(build.finishEnvironmentBuild).toHaveBeenCalledTimes(2);
	expect(requestState()).toBe("done");
});

it("does not touch a VM for an unchanged environment and records preflight failures", async () => {
	build.resolveEnvironmentBuildInput.mockResolvedValueOnce(null);
	const { object } = fixture();
	await object.start(request);
	await runAlarm(object);
	expect(build.claimEnvironmentBuild).not.toHaveBeenCalled();
	build.resolveEnvironmentBuildInput.mockRejectedValueOnce(
		new Error("private"),
	);
	await object.start({
		...request,
		requestId: "00000000-0000-4000-8000-000000000009",
	});
	await runAlarm(object);
	expect(build.failEnvironmentPreflight).toHaveBeenCalledWith(workspaceId);
	expect(build.claimEnvironmentBuild).not.toHaveBeenCalled();
});
