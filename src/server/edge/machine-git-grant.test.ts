import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	GIT_GRANT_USERNAME,
	type MachineGitGrant,
} from "#/domain/github-git-proxy";
import {
	answerMachineGitGrant,
	type MachineGitSources,
	machineGitHooks,
	resolveMachineAccess,
} from "./machine-git-grant";

const pushes = vi.hoisted(() => ({
	claimApproved: vi.fn(async () => false),
	recordRefused: vi.fn(async () => {}),
}));
vi.mock("../adapters/git-push-requests", () => ({ gitPushRequests: pushes }));

const SECRET = "machine-git-grant-test-secret-0123456789";
const chat = {
	userId: "alice",
	sessionId: "00000000-0000-4000-8000-0000000000aa",
	projectId: "00000000-0000-4000-8000-000000000001",
};

function sources(
	overrides: Partial<MachineGitSources> = {},
): MachineGitSources {
	return {
		chatIsLive: async () => true,
		projectRepository: async (_chat, fullName) =>
			fullName.toLowerCase() === "acme/app"
				? { installationId: 11, fullName: "Acme/app" }
				: null,
		githubToken: async () => "user-token",
		repository: async (_token, _owner, name) =>
			name === "missing"
				? null
				: {
						private: name !== "public",
						defaultBranch: "main",
						push: name !== "readonly",
					},
		installationToken: async (_id, name) => {
			if (name === "not-installed") throw new Error("not in installation");
			return `installation-token-${name}`;
		},
		projectAllowsDefaultBranchPush: async () => false,
		...overrides,
	};
}

const refusal = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(cause: Error & { status?: number }) => ({
			status: cause.status,
			message: cause.message,
		}),
	);

describe("resolveMachineAccess", () => {
	it("writes only to the chat's project repositories, with the user's push permission", async () => {
		expect(
			await resolveMachineAccess(
				chat,
				{ owner: "acme", name: "APP", access: "write" },
				sources(),
			),
		).toEqual({
			owner: "Acme",
			name: "app",
			installationId: 11,
			token: "installation-token-app",
			defaultBranch: "main",
		});
		expect(
			await refusal(
				resolveMachineAccess(
					chat,
					{ owner: "acme", name: "other", access: "write" },
					sources(),
				),
			),
		).toMatchObject({
			status: 403,
			message: expect.stringContaining("not one of them"),
		});
		expect(
			await refusal(
				resolveMachineAccess(
					chat,
					{ owner: "acme", name: "app", access: "write" },
					sources({
						repository: async () => ({
							private: true,
							defaultBranch: "main",
							push: false,
						}),
					}),
				),
			),
		).toMatchObject({ message: expect.stringContaining("cannot push") });
	});

	it("reads the project's repositories and public ones (anonymously), no other private one", async () => {
		expect(
			await resolveMachineAccess(
				chat,
				{ owner: "acme", name: "app", access: "read" },
				sources(),
			),
		).toMatchObject({ installationId: 11, token: "installation-token-app" });
		// The user's installation reaches acme/lib, but it is not in the project.
		const installationToken = vi.fn(async () => "installation-token");
		expect(
			await refusal(
				resolveMachineAccess(
					chat,
					{ owner: "acme", name: "lib", access: "read" },
					sources({ installationToken }),
				),
			),
		).toEqual({
			status: 403,
			message:
				"acme/lib is not in this project; add it to the project to use it here.",
		});
		expect(installationToken).not.toHaveBeenCalled();
		expect(
			await resolveMachineAccess(
				chat,
				{ owner: "acme", name: "public", access: "read" },
				sources({ installationToken }),
			),
		).toMatchObject({ token: null });
		expect(installationToken).not.toHaveBeenCalled();
		expect(
			await resolveMachineAccess(
				chat,
				{ owner: "someone", name: "public", access: "read" },
				sources(),
			),
		).toEqual({
			owner: "someone",
			name: "public",
			token: null,
			defaultBranch: "main",
		});
		expect(
			await refusal(
				resolveMachineAccess(
					chat,
					{ owner: "someone", name: "private", access: "read" },
					sources(),
				),
			),
		).toMatchObject({
			message: expect.stringContaining(
				"someone/private is not in this project",
			),
		});
		expect(
			await refusal(
				resolveMachineAccess(
					chat,
					{ owner: "acme", name: "missing", access: "read" },
					sources(),
				),
			),
		).toMatchObject({ message: expect.stringContaining("was not found") });
	});

	it("refuses an archived chat and a disconnected GitHub", async () => {
		expect(
			await refusal(
				resolveMachineAccess(
					chat,
					{ owner: "acme", name: "app", access: "read" },
					sources({ chatIsLive: async () => false }),
				),
			),
		).toMatchObject({ status: 401 });
		expect(
			await refusal(
				resolveMachineAccess(
					chat,
					{ owner: "acme", name: "app", access: "read" },
					sources({
						githubToken: async () => {
							throw new Response("Reconnect GitHub.", { status: 409 });
						},
					}),
				),
			),
		).toMatchObject({
			message: expect.stringContaining("GitHub is not connected"),
		});
	});
});

describe("answerMachineGitGrant", () => {
	const post = (body: unknown, token = "ygm_valid") =>
		new Request("https://edge.test/machine-git/grant", {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
	const owner = async (token: string) =>
		token === "ygm_valid"
			? { ...chat, holder: "step" as const }
			: token === "ygm_terminal"
				? { ...chat, holder: "terminal" as const }
				: null;
	const grantOf = async (response: Response) => {
		const { password } = (await response.clone().json()) as {
			password: string;
		};
		const headers = JSON.parse(
			atob(password.replaceAll("-", "+").replaceAll("_", "/")),
		) as Record<string, string>;
		return JSON.parse(headers["x-ytimesy-git-grant"]) as Record<
			string,
			unknown
		>;
	};

	it("trades a live token for Basic credentials carrying a signed grant", async () => {
		const response = await answerMachineGitGrant(
			post({ owner: "acme", name: "app", access: "write" }),
			SECRET,
			sources(),
			owner,
		);
		expect(response.status).toBe(200);
		const { username, password } = (await response.json()) as {
			username: string;
			password: string;
		};
		expect(username).toBe(GIT_GRANT_USERNAME);
		const headers = JSON.parse(
			atob(password.replaceAll("-", "+").replaceAll("_", "/")),
		) as Record<string, string>;
		expect(JSON.parse(headers["x-ytimesy-git-grant"])).toMatchObject({
			kind: "machine",
			userId: "alice",
			sessionId: chat.sessionId,
			owner: "acme",
			name: "app",
			installationId: 11,
			access: "write",
		});
	});

	it("marks a terminal's grant, so its push to main points at the chat; a step's carries no holder", async () => {
		const request = { owner: "acme", name: "app", access: "write" };
		expect(
			await grantOf(
				await answerMachineGitGrant(
					post(request, "ygm_terminal"),
					SECRET,
					sources(),
					owner,
				),
			),
		).toMatchObject({ holder: "terminal" });
		expect(
			await grantOf(
				await answerMachineGitGrant(post(request), SECRET, sources(), owner),
			),
		).not.toHaveProperty("holder");
	});

	it("refuses an unknown token, a malformed request and says why for a refused repository", async () => {
		expect(
			(
				await answerMachineGitGrant(
					post({}, "ygm_other"),
					SECRET,
					sources(),
					owner,
				)
			).status,
		).toBe(401);
		expect(
			(
				await answerMachineGitGrant(
					post({ owner: "../x", name: "app", access: "read" }),
					SECRET,
					sources(),
					owner,
				)
			).status,
		).toBe(400);
		const refused = await answerMachineGitGrant(
			post({ owner: "acme", name: "other", access: "write" }),
			SECRET,
			sources(),
			owner,
		);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toContain(
			"this project's repositories",
		);
	});
});

describe("machineGitHooks", () => {
	const grant: MachineGitGrant = {
		kind: "machine",
		...chat,
		owner: "acme",
		name: "app",
		installationId: 11,
		access: "write",
		nonce: "a".repeat(32),
	};
	const update = {
		oldId: "b".repeat(40),
		newId: "c".repeat(40),
		ref: "refs/heads/main",
	};
	beforeEach(() => {
		pushes.claimApproved.mockReset().mockResolvedValue(false);
		pushes.recordRefused.mockReset().mockResolvedValue(undefined);
	});

	it("re-checks every operation and refuses a grant whose installation changed", async () => {
		expect(await machineGitHooks(sources()).authorize(grant)).toMatchObject({
			token: "installation-token-app",
		});
		expect(
			await machineGitHooks(sources()).authorize({
				...grant,
				installationId: 12,
			}),
		).toBeNull();
		expect(
			await machineGitHooks(
				sources({ chatIsLive: async () => false }),
			).authorize(grant),
		).toBeNull();
	});

	it("allows main by the project setting, else spends an approval of exactly this push, else records it", async () => {
		expect(
			await machineGitHooks(
				sources({ projectAllowsDefaultBranchPush: async () => true }),
			).defaultBranchPush(grant, update),
		).toBe(true);
		expect(pushes.claimApproved).not.toHaveBeenCalled();

		expect(
			await machineGitHooks(sources()).defaultBranchPush(grant, update),
		).toBe(false);
		expect(pushes.recordRefused).toHaveBeenCalledWith({
			userId: "alice",
			projectId: chat.projectId,
			sessionId: chat.sessionId,
			owner: "acme",
			name: "app",
			branch: "main",
			oldId: update.oldId,
			newId: update.newId,
		});

		pushes.claimApproved.mockResolvedValueOnce(true);
		expect(
			await machineGitHooks(sources()).defaultBranchPush(grant, update),
		).toBe(true);
		expect(pushes.claimApproved).toHaveBeenLastCalledWith({
			userId: "alice",
			projectId: chat.projectId,
			owner: "acme",
			name: "app",
			branch: "main",
			newId: update.newId,
		});
	});
});
