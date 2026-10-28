import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import {
	ensureProjectCheckout,
	loadTenantProjectCheckout,
} from "./project-workspace";
import { commitChatBranchForSubmission } from "./session-branch";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * A new chat started "from release": its own branch is created from
 * release, its checkout fetches release, and its pull requests target it.
 */
const store = vi.hoisted(() => ({
	chat: null as AgentSessionRecord | null,
	remote: new Set<string>(["main", "release"]),
}));
const receive = vi.hoisted(() => vi.fn(async () => "updated"));

vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: async () => store.chat,
	projectBranchHeldByOtherSession: async () => false,
	saveSessionWorkingBranch: async (
		_user: string,
		_id: string,
		branch: string,
		baseBranch?: string,
	) => {
		if (!store.chat) throw new Error("missing chat");
		store.chat = {
			...store.chat,
			selectedBranch: branch,
			workingBranch: branch,
			baseBranch: baseBranch ?? store.chat.baseBranch ?? null,
		};
		return store.chat;
	},
}));
vi.mock("#/server/adapters/projects", () => {
	const project = {
		id: "project-1",
		fullName: "acme/app",
		installationId: 1,
		repositoryId: 2,
		branch: "main",
	};
	return {
		projectForOwner: async () => project,
		listProjects: async () => [project],
	};
});
vi.mock("#/server/auth/github-connection", () => ({
	githubAccessToken: async () => "user-token",
}));
vi.mock("#/server/adapters/github", () => ({
	authorizedRepository: async () => ({
		installationId: 1,
		repositoryId: 2,
		fullName: "acme/app",
		defaultBranch: "main",
	}),
	repositoryBranchSha: async (_token: string, _repo: string, ref: string) =>
		store.remote.has(ref) ? "a".repeat(40) : null,
	repositoryFileAtCommit: async () => null,
}));
vi.mock("#/server/adapters/github/git-broker", () => ({
	receiveBrokeredRepository: receive,
}));
vi.mock("#/server/adapters/github/installation-token", () => ({
	githubInstallationAccessToken: async () => "installation-token",
}));

const newChat = {
	id: "a1b2c3d4",
	userId: "alice",
	projectId: "project-1",
	parentSessionId: null,
	turnStatus: "idle",
	items: [],
	title: "New session",
	selectedBranch: null,
	workingBranch: null,
	baseBranch: null,
} as unknown as AgentSessionRecord;

const submit = (baseBranch?: string) =>
	commitChatBranchForSubmission({
		userId: "alice",
		projectId: "project-1",
		sessionId: newChat.id,
		text: "Fix the parser",
		baseBranch,
	});

beforeEach(() => {
	store.chat = { ...newChat };
	receive.mockClear();
});

it("creates a new chat's own branch from the picked base and keeps that base", async () => {
	const chat = await submit("release");
	expect(chat.workingBranch).toBe("ytimesy/fix-the-parser-b2c3d4");
	expect(chat.baseBranch).toBe("release");
});

it("starts from the project's branch when nothing was picked", async () => {
	const chat = await submit();
	expect(chat.workingBranch).toBe("ytimesy/fix-the-parser-b2c3d4");
	expect(chat.baseBranch).toBe("main");
});

it("rejects a picked base that is invalid, another chat's branch, or gone from GitHub", async () => {
	await expect(submit("bad..name")).rejects.toThrow(/repository branch/);
	await expect(submit("ytimesy/other-chat-123456")).rejects.toThrow(
		/repository branch/,
	);
	await expect(submit("deleted")).rejects.toThrow(/no longer on GitHub/);
	expect(store.chat?.workingBranch).toBeNull();
});

it("ignores a base sent once the chat has a branch of its own", async () => {
	await submit("release");
	const again = await submit("main");
	expect(again.baseBranch).toBe("release");
	expect(again.workingBranch).toBe("ytimesy/fix-the-parser-b2c3d4");
});

it("plans the chat's checkout from the picked base onto its own branch", async () => {
	await submit("release");
	const checkout = await Effect.runPromise(
		loadTenantProjectCheckout({
			userId: "alice",
			projectId: "project-1",
			sessionId: newChat.id,
		}),
	);
	expect(checkout).toMatchObject({
		fullName: "acme/app",
		branch: "release",
		workingBranch: "ytimesy/fix-the-parser-b2c3d4",
		preserveCurrentBranch: true,
	});
	// A template copy still on main switches: it fetches release and starts
	// the chat's branch there.
	const machines = {
		exec: vi.fn(async (_vm: unknown, command: string) => ({
			exitCode: 0,
			stdout: command.includes("branch --show-current")
				? "main\n"
				: "present\n/home/ubuntu/app\n",
			stderr: "",
		})),
		writeTextFile: vi.fn(async () => undefined),
	} as unknown as WorkspaceMachines;
	await Effect.runPromise(
		ensureProjectCheckout(machines, "vm" as WorkspaceId, checkout),
	);
	expect(receive).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			branch: "release",
			workingBranch: "ytimesy/fix-the-parser-b2c3d4",
			mode: "switch",
		}),
	);
});

it("keeps the agent's branch on the next turn instead of switching back", async () => {
	await submit("release");
	if (store.chat)
		store.chat = {
			...store.chat,
			selectedBranch: "agent/hotfix",
			workingBranch: "agent/hotfix",
		};
	const checkout = await Effect.runPromise(
		loadTenantProjectCheckout({
			userId: "alice",
			projectId: "project-1",
			sessionId: newChat.id,
		}),
	);
	expect(checkout).toMatchObject({
		branch: "release",
		workingBranch: "agent/hotfix",
	});
	const machines = {
		exec: vi.fn(async (_vm: unknown, command: string) => ({
			exitCode: 0,
			stdout: command.includes("branch --show-current")
				? "agent/hotfix\n"
				: "present\n/home/ubuntu/app\n",
			stderr: "",
		})),
		writeTextFile: vi.fn(async () => undefined),
	} as unknown as WorkspaceMachines;
	await Effect.runPromise(
		ensureProjectCheckout(machines, "vm" as WorkspaceId, checkout),
	);
	expect(receive).not.toHaveBeenCalled();
});
