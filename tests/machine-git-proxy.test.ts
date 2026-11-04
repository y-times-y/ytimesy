import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_BRANCH_PUSH_REFUSAL,
	GIT_GRANT_USERNAME,
	gitGrantPassword,
	issueGitProxyGrant,
	issueMachineGitGrant,
	type MachineGitHooks,
	machinePushVerdicts,
	proxyGithubGit,
	refusedPushReport,
} from "../src/domain/github-git-proxy";

const secret = "test-only-signing-key-for-git-proxy-123456789";
const machine = {
	userId: "user-1",
	sessionId: "00000000-0000-4000-8000-0000000000aa",
	projectId: "00000000-0000-4000-8000-000000000001",
	owner: "Owner",
	name: "repo",
	installationId: 123,
} as const;
const zero = "0".repeat(40);
const commit = "a".repeat(40);
const other = "b".repeat(40);
const pkt = (line: string) =>
	`${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

async function basic(access: "read" | "write", extra = {}) {
	const headers = await issueMachineGitGrant(secret, {
		...machine,
		access,
		...extra,
	});
	return `Basic ${btoa(`${GIT_GRANT_USERNAME}:${gitGrantPassword(headers)}`)}`;
}

async function push(body: string, extra = {}) {
	return new Request("https://proxy.test/git/owner/REPO/git-receive-pack", {
		method: "POST",
		headers: {
			authorization: await basic("write", extra),
			"content-type": "application/x-git-receive-pack-request",
		},
		body,
	});
}

function hooks(
	overrides: Partial<MachineGitHooks> = {},
): MachineGitHooks & { approvals: string[] } {
	const approvals: string[] = [];
	return {
		approvals,
		authorize: vi.fn(async () => ({ token: "t", defaultBranch: "main" })),
		defaultBranchPush: vi.fn(async (_grant, update) => {
			approvals.push(update.newId);
			return false;
		}),
		...overrides,
	};
}

function claims() {
	const spent = new Set<string>();
	return vi.fn(async (nonce: string) => {
		if (spent.has(nonce)) return false;
		spent.add(nonce);
		return true;
	});
}

const ok = () => vi.fn(async () => new Response("ok"));

describe("plain git's grants at the proxy", () => {
	it("challenges a request without credentials, naming fetch or push for the helper", async () => {
		const fetchRefs = await proxyGithubGit(
			new Request(
				"https://proxy.test/git/owner/repo/info/refs?service=git-upload-pack",
			),
			secret,
			vi.fn(),
		);
		expect(fetchRefs.status).toBe(401);
		expect(fetchRefs.headers.get("www-authenticate")).toBe(
			'Basic realm="ytimesy git fetch"',
		);
		const pushRefs = await proxyGithubGit(
			new Request(
				"https://proxy.test/git/owner/repo/info/refs?service=git-receive-pack",
			),
			secret,
			vi.fn(),
		);
		expect(pushRefs.headers.get("www-authenticate")).toBe(
			'Basic realm="ytimesy git push"',
		);
		// Bad credentials are refused without a new challenge.
		const bad = await proxyGithubGit(
			new Request("https://proxy.test/git/owner/repo/info/refs", {
				headers: {
					authorization: `Basic ${btoa(`ytimesy-grant:${gitGrantPassword({ "x-ytimesy-git-grant": "{}" })}`)}`,
				},
			}),
			secret,
			vi.fn(),
		);
		expect(bad.status).toBe(401);
		expect(bad.headers.has("www-authenticate")).toBe(false);
	});

	it("reads with Basic credentials, any case and without .git, anonymously for a public repository", async () => {
		const upstream = ok();
		const machineHooks = hooks({
			authorize: vi.fn(async () => ({ token: null, defaultBranch: "main" })),
		});
		const response = await proxyGithubGit(
			new Request(
				"https://proxy.test/git/owner/REPO/info/refs?service=git-upload-pack",
				{
					headers: {
						authorization: await basic("read", { installationId: undefined }),
					},
				},
			),
			secret,
			vi.fn(),
			upstream as unknown as typeof fetch,
			claims(),
			machineHooks,
		);
		expect(response.status).toBe(200);
		const [target, init] = upstream.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(target).toBe(
			"https://github.com/Owner/repo.git/info/refs?service=git-upload-pack",
		);
		expect(new Headers(init.headers).has("authorization")).toBe(false);
	});

	it("refuses a machine grant for another repository, and when the edge wires no machine checks", async () => {
		const request = async (path: string) =>
			new Request(`https://proxy.test${path}`, {
				headers: { authorization: await basic("read") },
			});
		expect(
			(
				await proxyGithubGit(
					await request("/git/owner/other/info/refs?service=git-upload-pack"),
					secret,
					vi.fn(),
					ok() as unknown as typeof fetch,
					claims(),
					hooks(),
				)
			).status,
		).toBe(403);
		expect(
			(
				await proxyGithubGit(
					await request("/git/owner/repo/info/refs?service=git-upload-pack"),
					secret,
					vi.fn(),
				)
			).status,
		).toBe(403);
	});

	it("pushes several non-default branches, force pushes included, and spends the grant once", async () => {
		const upstream = ok();
		const claim = claims();
		const body = `${pkt(`${commit} ${other} refs/heads/feature\0report-status side-band-64k`)}${pkt(`${zero} ${commit} refs/heads/ytimesy/two`)}0000PACK`;
		const first = await push(body);
		const replay = new Request(first.url, {
			method: "POST",
			headers: first.headers,
			body,
		});
		const machineHooks = hooks();
		expect(
			(
				await proxyGithubGit(
					first,
					secret,
					vi.fn(),
					upstream as unknown as typeof fetch,
					claim,
					machineHooks,
				)
			).status,
		).toBe(200);
		expect(
			(
				await proxyGithubGit(
					replay,
					secret,
					vi.fn(),
					upstream as unknown as typeof fetch,
					claim,
					machineHooks,
				)
			).status,
		).toBe(403);
		expect(upstream).toHaveBeenCalledTimes(1);
		expect(machineHooks.defaultBranchPush).not.toHaveBeenCalled();
	});

	it("answers a refused push in git's words: deletes, tags, and main without approval", async () => {
		const upstream = ok();
		const claim = claims();
		for (const [line, reason] of [
			[
				`${commit} ${zero} refs/heads/feature`,
				"deleting branches is not allowed",
			],
			[`${zero} ${commit} refs/tags/v1`, "only branches can be pushed"],
			[`${zero} ${commit} refs/heads/main`, DEFAULT_BRANCH_PUSH_REFUSAL],
		]) {
			const machineHooks = hooks();
			const response = await proxyGithubGit(
				await push(`${pkt(`${line}\0report-status side-band-64k`)}0000PACK`),
				secret,
				vi.fn(),
				upstream as unknown as typeof fetch,
				claim,
				machineHooks,
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(
				"application/x-git-receive-pack-result",
			);
			const text = await response.text();
			expect(text).toContain(`ng ${line.split(" ")[2]} ${reason}`);
			if (reason === DEFAULT_BRANCH_PUSH_REFUSAL) {
				expect(text).toContain("\u0002Call request_push_approval");
				expect(machineHooks.approvals).toEqual([commit]);
			}
		}
		expect(upstream).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
	});

	it("pushes main once the project allows it or the user approved it", async () => {
		const upstream = ok();
		const response = await proxyGithubGit(
			await push(
				`${pkt(`${other} ${commit} refs/heads/main\0report-status`)}0000PACK`,
			),
			secret,
			vi.fn(),
			upstream as unknown as typeof fetch,
			claims(),
			hooks({ defaultBranchPush: vi.fn(async () => true) }),
		);
		expect(response.status).toBe(200);
		expect(upstream).toHaveBeenCalledTimes(1);
	});

	it("keeps a grant named for one branch to that branch", async () => {
		const response = await proxyGithubGit(
			await push(
				`${pkt(`${zero} ${commit} refs/heads/other\0report-status`)}0000PACK`,
				{ branch: "feature" },
			),
			secret,
			vi.fn(),
			ok() as unknown as typeof fetch,
			claims(),
			hooks(),
		);
		expect(await response.text()).toContain(
			"ng refs/heads/other this push may update only feature",
		);
	});

	it("refuses machine writes without an installation", async () => {
		await expect(
			issueMachineGitGrant(secret, {
				...machine,
				installationId: undefined,
				access: "write",
			}),
		).rejects.toThrow();
		await expect(
			issueMachineGitGrant(secret, { ...machine, access: "read", branch: "x" }),
		).rejects.toThrow();
	});
});

describe("an approved push's server grant", () => {
	it("updates the branch to exactly the commit it names, once", async () => {
		const headers = await issueGitProxyGrant(secret, {
			userId: machine.userId,
			projectId: machine.projectId,
			owner: "owner",
			name: "repo",
			installationId: 123,
			access: "write",
			branch: "main",
			commit,
		});
		const request = (newId: string) =>
			new Request("https://proxy.test/git/owner/repo.git/git-receive-pack", {
				method: "POST",
				headers: {
					...headers,
					"content-type": "application/x-git-receive-pack-request",
				},
				body: `${pkt(`${other} ${newId} refs/heads/main\0report-status`)}0000PACK`,
			});
		const upstream = ok();
		const claim = claims();
		expect(
			(
				await proxyGithubGit(
					await request(other),
					secret,
					async () => "t",
					upstream as unknown as typeof fetch,
					claim,
				)
			).status,
		).toBe(403);
		expect(
			(
				await proxyGithubGit(
					await request(commit),
					secret,
					async () => "t",
					upstream as unknown as typeof fetch,
					claim,
				)
			).status,
		).toBe(200);
		expect(upstream).toHaveBeenCalledTimes(1);
		await expect(
			issueGitProxyGrant(secret, {
				userId: machine.userId,
				projectId: machine.projectId,
				owner: "owner",
				name: "repo",
				installationId: 123,
				access: "read",
				commit,
			}),
		).rejects.toThrow();
	});
});

describe("push rules and refusal report", () => {
	it("allows any non-default branch and marks the default one", () => {
		expect(
			machinePushVerdicts(
				[
					{ oldId: commit, newId: other, ref: "refs/heads/feature" },
					{ oldId: other, newId: commit, ref: "refs/heads/main" },
					{ oldId: commit, newId: zero, ref: "refs/heads/old" },
					{ oldId: zero, newId: commit, ref: "refs/notes/x" },
				],
				{ defaultBranch: "main" },
			),
		).toEqual([
			null,
			"default",
			"deleting branches is not allowed",
			"only branches can be pushed",
		]);
	});

	it("writes plain report-status without side-band", () => {
		const report = new TextDecoder().decode(
			refusedPushReport(
				[{ oldId: zero, newId: commit, ref: "refs/heads/main" }],
				["needs approval"],
				["report-status"],
				["ignored without side-band"],
			),
		);
		expect(report).toBe(
			`${pkt("unpack ok\n")}${pkt("ng refs/heads/main needs approval\n")}0000`,
		);
	});
});
