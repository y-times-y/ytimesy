import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type HandoffDocument,
	importSecretHash,
	newImportToken,
} from "#/domain/local-import";
import type { LocalImportRow } from "../adapters/local-imports";

const mocks = vi.hoisted(() => ({
	githubConnected: vi.fn(),
	githubToken: vi.fn(),
	consume: vi.fn(),
	require: vi.fn(),
	insertImport: vi.fn(),
	redeem: vi.fn(),
	byCode: vi.fn(),
	byToken: vi.fn(),
	progress: vi.fn(),
	cancelRow: vi.fn(),
	forOwner: vi.fn(),
	bySource: vi.fn(),
	readObject: vi.fn(),
	storeObject: vi.fn(),
	saveSession: vi.fn(),
	listProjects: vi.fn(),
	projectForOwner: vi.fn(),
	creation: vi.fn(),
	reachable: vi.fn(),
	workspace: vi.fn(),
	enqueue: vi.fn(),
	listChats: vi.fn(),
	insertChat: vi.fn(),
	workingBranch: vi.fn(),
	saveItems: vi.fn(),
	recipes: vi.fn(),
	saveEnvironment: vi.fn(),
	sendMessage: vi.fn(),
}));

vi.mock("../config", () => ({
	serverConfig: () => ({
		APP_URL: "https://ytimesy.test",
		GITHUB_APP_SLUG: "ytimesy",
	}),
}));
vi.mock("../auth/github-connection", () => ({
	githubConnectionExists: mocks.githubConnected,
	githubAccessToken: mocks.githubToken,
}));
vi.mock("../adapters/user-action-rate", () => ({
	consumeUserAction: mocks.consume,
	requireUserAction: mocks.require,
}));
vi.mock("../adapters/local-imports", () => ({
	insertLocalImport: mocks.insertImport,
	redeemLocalImportCode: mocks.redeem,
	localImportByCodeHash: mocks.byCode,
	localImportByTokenHash: mocks.byToken,
	localImportForOwner: mocks.forOwner,
	cancelLocalImportRow: mocks.cancelRow,
	finishedLocalImports: vi.fn(),
	saveLocalImportProgress: mocks.progress,
	importedSessionBySource: mocks.bySource,
	importedSessionOfImport: vi.fn(),
	saveImportedSession: mocks.saveSession,
	saveImportedTranscriptSize: vi.fn(),
}));
vi.mock("../adapters/handoff-store", () => ({
	readHandoffObject: mocks.readObject,
	storeHandoffObject: mocks.storeObject,
}));
vi.mock("../adapters/projects", () => ({
	listProjects: mocks.listProjects,
	projectForOwner: mocks.projectForOwner,
}));
vi.mock("../adapters/github", () => ({
	githubRepositoryCreation: mocks.creation,
	listAuthorizedRepositories: mocks.reachable,
	repositoryBranchSha: vi.fn(),
}));
vi.mock("../adapters/workspaces", () => ({
	workspaceForProject: mocks.workspace,
}));
vi.mock("./workspaces", () => ({ enqueueProjectWorkspace: mocks.enqueue }));
vi.mock("../adapters/agent-sessions", () => ({
	listAgentSessions: mocks.listChats,
	insertAgentSession: mocks.insertChat,
	saveSessionWorkingBranch: mocks.workingBranch,
	saveAgentSessionItems: mocks.saveItems,
}));
vi.mock("../adapters/environment-recipes", () => ({
	latestEnvironmentRecipes: mocks.recipes,
}));
vi.mock("./project-environment-setup", () => ({
	saveProjectEnvironment: mocks.saveEnvironment,
}));
vi.mock("./project-secrets", () => ({ saveImportedProjectSecrets: vi.fn() }));
vi.mock("./projects", () => ({ createScratchProject: vi.fn() }));
// The import must never start a model turn; this module is how chats send one.
vi.mock("./queued-user-messages", () => ({
	sendComposerMessage: mocks.sendMessage,
}));

const {
	cancelLocalImport,
	createLocalImport,
	finishImport,
	importSession,
	requireImportCaller,
	startLocalImport,
} = await import("./local-import");

const PROJECT = "11111111-1111-4111-8111-111111111111";
const IMPORTED = "22222222-2222-4222-8222-222222222222";
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

function importRow(overrides: Partial<LocalImportRow> = {}): LocalImportRow {
	return {
		id: "33333333-3333-4333-8333-333333333333",
		userId: "alice",
		status: "importing",
		codeExpiresAt: later(-5),
		codeUsedAt: later(-10),
		tokenExpiresAt: later(60),
		agent: "claude",
		sessionsPlanned: 2,
		sessionsImported: 2,
		projectId: null,
		sessionId: null,
		message: null,
		...overrides,
	};
}

const handoff: HandoffDocument = {
	version: 1,
	tool: "claude",
	sessionId: "local-1",
	title: "Fix the login redirect",
	cwd: "/Users/alice/app",
	updatedAt: "2026-10-31T18:30:00Z",
	totalTurns: 42,
	turns: [{ role: "user", text: "The login page loops.", toolCalls: [] }],
	successfulCommands: ["pnpm install", "pnpm test"],
	files: { edited: ["src/auth.ts"], written: [], read: [] },
};

const project = {
	id: PROJECT,
	repositoryId: 7,
	installationId: 9,
	fullName: "alice/app",
	branch: "main",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.githubConnected.mockResolvedValue(true);
	mocks.githubToken.mockResolvedValue("gh-token");
	mocks.consume.mockResolvedValue(undefined);
	mocks.require.mockResolvedValue(undefined);
	mocks.listProjects.mockResolvedValue([project]);
	mocks.projectForOwner.mockResolvedValue(project);
	mocks.creation.mockResolvedValue({ owner: "alice", canCreate: true });
	mocks.bySource.mockResolvedValue({
		id: IMPORTED,
		projectId: PROJECT,
		tool: "claude",
		sourceSessionId: "local-1",
	});
	mocks.readObject.mockResolvedValue(
		new TextEncoder().encode(JSON.stringify(handoff)),
	);
	mocks.workspace.mockResolvedValue({ id: "ws-1", status: "ready" });
	mocks.listChats.mockResolvedValue([
		{ harness: "api", listedModelId: "conn|model", parentSessionId: null },
	]);
	mocks.insertChat.mockResolvedValue({ id: "chat-1" });
	mocks.workingBranch.mockResolvedValue({ id: "chat-1" });
	mocks.saveItems.mockResolvedValue({ id: "chat-1" });
	mocks.recipes.mockResolvedValue(new Map());
	mocks.saveEnvironment.mockResolvedValue({});
});

describe("codes", () => {
	it("needs GitHub, counts against the code limit and stores only the hash", async () => {
		const created = await createLocalImport("alice");
		expect(mocks.consume).toHaveBeenCalledWith("alice", "local-import-code");
		const code = /YTM-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(
			created.prompt,
		)?.[0] as string;
		expect(code).toBeDefined();
		const stored = mocks.insertImport.mock.calls[0]?.[0];
		expect(stored.codeHash).toBe(importSecretHash(code));
		expect(JSON.stringify(stored)).not.toContain(code);
		expect(stored.codeExpiresAt.getTime() - Date.now()).toBeGreaterThan(
			14 * 60_000,
		);
		expect(stored.codeExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
			15 * 60_000,
		);

		mocks.githubConnected.mockResolvedValue(false);
		await expect(createLocalImport("alice")).rejects.toThrow(/Connect GitHub/);
	});

	it("start spends the code once and returns a token stored only as a hash", async () => {
		mocks.redeem.mockResolvedValue(importRow({ status: "connected" }));
		const started = await startLocalImport({
			code: "ytm-abcd-efgh-jkmn",
			agent: "claude",
		});
		const redeemed = mocks.redeem.mock.calls[0]?.[0];
		expect(redeemed.codeHash).toBe(importSecretHash("YTM-ABCD-EFGH-JKMN"));
		expect(redeemed.tokenHash).toBe(importSecretHash(started.token));
		expect(redeemed.tokenExpiresAt.getTime() - Date.now()).toBeGreaterThan(
			119 * 60_000,
		);
		expect(started).toMatchObject({
			projects: [{ id: PROJECT, name: "app", repositories: ["alice/app"] }],
			canCreateRepository: true,
			repositoryOwner: "alice",
		});
	});

	it("start refuses a used, expired or malformed code", async () => {
		mocks.redeem.mockResolvedValue(null);
		mocks.byCode.mockResolvedValue({
			codeExpiresAt: later(5),
			codeUsedAt: later(-1),
		});
		const used = await startLocalImport({ code: "YTM-ABCD-EFGH-JKMN" }).catch(
			(error) => error,
		);
		expect(used).toBeInstanceOf(Response);
		expect(used.status).toBe(410);
		expect(await used.text()).toMatch(/already used/);

		mocks.byCode.mockResolvedValue({
			codeExpiresAt: later(-1),
			codeUsedAt: null,
		});
		const expired = await startLocalImport({
			code: "YTM-ABCD-EFGH-JKMN",
		}).catch((error) => error);
		expect(await expired.text()).toMatch(/expired/);

		const malformed = await startLocalImport({ code: "hello" }).catch(
			(error) => error,
		);
		expect(malformed.status).toBe(400);
	});
});

describe("tokens", () => {
	const request = (token?: string) =>
		new Request("https://ytimesy.test/api/local-import/plan", {
			method: "POST",
			headers: token ? { authorization: `Bearer ${token}` } : {},
		});

	it("scope every call to the import's user and its rate limit", async () => {
		const token = newImportToken();
		mocks.byToken.mockResolvedValue(importRow({ userId: "bob" }));
		const caller = await requireImportCaller(request(token));
		expect(mocks.byToken).toHaveBeenCalledWith(importSecretHash(token));
		expect(caller.userId).toBe("bob");
		expect(mocks.require).toHaveBeenCalledWith("bob", "local-import-call");
	});

	it("refuse a missing, unknown, expired or finished token", async () => {
		const missing = await requireImportCaller(request()).catch((e) => e);
		expect(missing.status).toBe(401);

		mocks.byToken.mockResolvedValue(null);
		const unknown = await requireImportCaller(request(newImportToken())).catch(
			(e) => e,
		);
		expect(unknown.status).toBe(401);

		mocks.byToken.mockResolvedValue(importRow({ tokenExpiresAt: later(-1) }));
		const expired = await requireImportCaller(request(newImportToken())).catch(
			(e) => e,
		);
		expect(expired.status).toBe(401);
		expect(await expired.text()).toMatch(/expired/);

		mocks.byToken.mockResolvedValue(importRow({ status: "ready" }));
		const finished = await requireImportCaller(request(newImportToken())).catch(
			(e) => e,
		);
		expect(await finished.text()).toMatch(/already finished/);
		// Only finish may repeat after it succeeded.
		await expect(
			requireImportCaller(request(newImportToken()), { finished: true }),
		).resolves.toMatchObject({ userId: "alice" });
		expect(mocks.require).toHaveBeenCalledTimes(1);
	});
});

describe("sessions", () => {
	it("store the handoff under the user's own project and count it", async () => {
		mocks.saveSession.mockResolvedValue({ id: IMPORTED, projectId: PROJECT });
		const caller = { importId: "imp", userId: "alice", row: importRow() };
		await expect(
			importSession(caller, { projectId: PROJECT, handoff, total: 3 }),
		).resolves.toEqual({
			importedSessionId: IMPORTED,
			transcriptUpload: `/api/local-import/transcript?session=${IMPORTED}`,
		});
		expect(mocks.saveSession.mock.calls[0]?.[0]).toMatchObject({
			importId: "imp",
			userId: "alice",
			projectId: PROJECT,
			tool: "claude",
			sourceSessionId: "local-1",
			turnCount: 42,
		});
		expect(mocks.storeObject).toHaveBeenCalledWith(
			{ userId: "alice", projectId: PROJECT },
			IMPORTED,
			"handoff.json",
			expect.any(Uint8Array),
		);
		expect(mocks.progress).toHaveBeenCalledWith("imp", {
			status: "importing",
			importedOne: true,
			sessionsPlanned: 3,
		});
	});

	it("refuse a project the user does not own", async () => {
		mocks.projectForOwner.mockResolvedValue(null);
		const refused = await importSession(
			{ importId: "imp", userId: "mallory", row: importRow() },
			{ projectId: PROJECT, handoff },
		).catch((e) => e);
		expect(refused.status).toBe(404);
		expect(mocks.saveSession).not.toHaveBeenCalled();
	});
});

describe("finish", () => {
	const caller = { importId: "imp", userId: "alice", row: importRow() };
	const request = {
		projectId: PROJECT,
		continue: { tool: "claude" as const, sessionId: "local-1" },
		branch: "ytimesy/continue-login",
		pushedFiles: 12,
		skippedFiles: 1,
		pushedPaths: ["src/auth.ts", "src/login.tsx"],
		skippedPaths: [".env"],
	};
	const pushed = { branchExists: vi.fn(async () => true) };

	it("opens the chat on the pushed branch with only the handoff card, and starts no turn", async () => {
		const result = await finishImport(caller, request, pushed);
		expect(result).toMatchObject({
			projectId: PROJECT,
			sessionId: "chat-1",
			openUrl: `https://ytimesy.test/?project=${PROJECT}&chat=chat-1`,
		});
		expect(pushed.branchExists).toHaveBeenCalledWith(
			"alice",
			"alice/app",
			"ytimesy/continue-login",
		);
		expect(mocks.insertChat).toHaveBeenCalledWith({
			userId: "alice",
			projectId: PROJECT,
			workspaceId: "ws-1",
			harness: "api",
			title: "Fix the login redirect",
			listedModelId: "conn|model",
		});
		expect(mocks.workingBranch).toHaveBeenCalledWith(
			"alice",
			"chat-1",
			"ytimesy/continue-login",
			"main",
		);
		// Items only: no turn status, so the chat stays idle and waits.
		expect(mocks.saveItems).toHaveBeenCalledTimes(1);
		const [chatId, items, ...rest] = mocks.saveItems.mock.calls[0] ?? [];
		expect(chatId).toBe("chat-1");
		expect(rest).toEqual([]);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: "handoff",
			tool: "claude",
			title: "Fix the login redirect",
			turns: 42,
			at: "2026-10-31T18:30:00Z",
		});
		expect(items[0].context).toContain("The login page loops.");
		// The card's summary and details, from the handoff alone.
		expect(items[0]).toMatchObject({
			branch: "ytimesy/continue-login",
			summary: {
				goal: "The login page loops.",
				stopped: null,
				edited: ["src/auth.ts"],
				commands: ["pnpm install", "pnpm test"],
				transcript: "~/.ytimesy/handoff/claude-local-1/transcript.md",
			},
			files: {
				pushed: ["src/auth.ts", "src/login.tsx"],
				pushedCount: 12,
				skipped: [".env"],
				skippedCount: 1,
			},
		});
		expect(items[0].context).toContain("~/.ytimesy/handoff/");
		expect(mocks.sendMessage).not.toHaveBeenCalled();
		expect(mocks.progress).toHaveBeenCalledWith("imp", {
			status: "ready",
			projectId: PROJECT,
			sessionId: "chat-1",
			message: "12 files pushed, 1 skipped.",
		});
	});

	it("saves a draft setup flagged as imported only when the repository has none", async () => {
		await finishImport(caller, request, pushed);
		expect(mocks.saveEnvironment).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "alice",
				projectId: PROJECT,
				repository: "alice/app",
				source: "import",
				summary: expect.stringMatching(/unverified/),
				recipe: expect.objectContaining({
					install: "pnpm install",
					checks: ["pnpm test"],
				}),
			}),
		);
		mocks.saveEnvironment.mockClear();
		mocks.recipes.mockResolvedValue(new Map([[7, {}]]));
		await finishImport(caller, request, pushed);
		expect(mocks.saveEnvironment).not.toHaveBeenCalled();
	});

	it("prepares the environment of a project that has none yet", async () => {
		mocks.workspace.mockResolvedValue(null);
		mocks.enqueue.mockReturnValue(Effect.succeed({ id: "ws-new" }));
		await finishImport(caller, request, pushed);
		expect(mocks.enqueue).toHaveBeenCalledWith("alice", PROJECT);
		expect(mocks.insertChat.mock.calls[0]?.[0].workspaceId).toBe("ws-new");
	});

	it("refuses an unpushed or invalid branch", async () => {
		const unpushed = await finishImport(caller, request, {
			branchExists: async () => false,
		}).catch((e) => e);
		expect(unpushed.status).toBe(409);
		expect(await unpushed.text()).toMatch(/Push ytimesy\/continue-login/);
		const invalid = await finishImport(
			caller,
			{ ...request, branch: "main" },
			pushed,
		).catch((e) => e);
		expect(invalid.status).toBe(400);
		expect(mocks.insertChat).not.toHaveBeenCalled();
	});

	it("returns the same chat when repeated after it succeeded", async () => {
		const done = {
			...caller,
			row: importRow({
				status: "ready",
				projectId: PROJECT,
				sessionId: "chat-1",
			}),
		};
		await expect(finishImport(done, request, pushed)).resolves.toMatchObject({
			sessionId: "chat-1",
		});
		expect(mocks.insertChat).not.toHaveBeenCalled();
	});
});

describe("cancel", () => {
	it("stops an unfinished import and shows it as cancelled", async () => {
		mocks.cancelRow.mockResolvedValue(
			importRow({ status: "failed", message: "Import cancelled." }),
		);
		await expect(cancelLocalImport("alice", "imp")).resolves.toMatchObject({
			status: "failed",
			message: "Import cancelled.",
		});
		expect(mocks.cancelRow).toHaveBeenCalledWith(
			"alice",
			"imp",
			"Import cancelled.",
		);
	});

	it("leaves a finished import as it is", async () => {
		mocks.cancelRow.mockResolvedValue(null);
		mocks.forOwner.mockResolvedValue(
			importRow({ status: "ready", projectId: PROJECT, sessionId: "chat-1" }),
		);
		await expect(cancelLocalImport("alice", "imp")).resolves.toMatchObject({
			status: "ready",
			sessionId: "chat-1",
		});
	});

	it("tells the CLI a cancelled import's token no longer works", async () => {
		const token = newImportToken();
		mocks.byToken.mockResolvedValue(
			importRow({ status: "failed", message: "Import cancelled." }),
		);
		const refused = await requireImportCaller(
			new Request("https://ytimesy.test/api/local-import/plan", {
				headers: { authorization: `Bearer ${token}` },
			}),
		).catch((e) => e);
		expect(refused.status).toBe(401);
		expect(await refused.text()).toBe(
			"Import cancelled. Copy a new prompt in ytimesy.",
		);
	});
});
