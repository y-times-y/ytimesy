import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pushProxiedRepository } from "./git-proxy-transfer";

beforeEach(() => {
	vi.stubEnv("YTIMESY_GIT_PROXY_URL", "https://proxy.example.test/");
	vi.stubEnv("YTIMESY_GIT_PROXY_SECRET", "p".repeat(48));
});
afterEach(() => vi.unstubAllEnvs());

function hostRefusing(stderr: string) {
	let step = 0;
	return {
		exec: async () => {
			step += 1;
			return step === 1
				? { exitCode: 0, stdout: "/tmp/ytimesy-git-proxy-abc\n", stderr: "" }
				: { exitCode: 1, stdout: "", stderr };
		},
		writeTextFile: async () => {},
	};
}

const repository = {
	owner: "o",
	name: "r",
	installationId: 1,
	userId: "00000000-0000-4000-8000-000000000001",
	projectId: "00000000-0000-4000-8000-000000000002",
	directory: "/home/ubuntu/r",
	branch: "ytimesy/chat",
};

it("names the missing Workflows permission when GitHub refuses a push that touches a workflow file", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await expect(
			pushProxiedRepository(
				hostRefusing(
					" ! [remote rejected] publish -> chat (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
				) as never,
				repository as never,
			),
		).rejects.toThrow("GitHub blocked the push");
	} finally {
		warn.mockRestore();
	}
});

it("keeps the generic message for any other refused push", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await expect(
			pushProxiedRepository(
				hostRefusing(
					" ! [rejected] publish -> chat (network unreachable)",
				) as never,
				repository as never,
			),
		).rejects.toThrow(
			"Workspace Git proxy transfer failed; check repository access.",
		);
	} finally {
		warn.mockRestore();
	}
});

/** A host whose pushes run in order: prepare, push, then (retry) prepare, push. */
function hostWithPushes(pushes: { exitCode: number; stderr: string }[]) {
	const commands: string[] = [];
	let push = 0;
	return {
		commands,
		exec: async (command: string) => {
			commands.push(command);
			if (command.includes("mktemp"))
				return {
					exitCode: 0,
					stdout: "/tmp/ytimesy-git-proxy-abc\n",
					stderr: "",
				};
			const outcome = pushes[push++] ?? { exitCode: 0, stderr: "" };
			return { stdout: "", ...outcome };
		},
		writeTextFile: async () => {},
	};
}

const rejected = {
	exitCode: 67,
	stderr:
		"hint: before pushing again. | hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
};
const turnRevision = `refs/ytimesy/turn-commits/${"a".repeat(64)}`;

it("merges the remote branch and pushes again, with a fresh grant, when a turn's push is not a fast-forward", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const host = hostWithPushes([rejected, { exitCode: 0, stderr: "" }]);
		await pushProxiedRepository(
			host as never,
			{
				...repository,
				revision: turnRevision,
			} as never,
		);
		const pushes = host.commands.filter((command) =>
			command.includes("push.git"),
		);
		expect(pushes).toHaveLength(2);
		expect(pushes[0]).not.toContain("merge-tree");
		expect(pushes[1]).toContain("merge-tree --write-tree");
	} finally {
		warn.mockRestore();
	}
});

it("says the branch diverged when the merge conflicts, and does not retry again", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const host = hostWithPushes([
			rejected,
			{ exitCode: 68, stderr: "CONFLICT" },
		]);
		await expect(
			pushProxiedRepository(
				host as never,
				{
					...repository,
					revision: turnRevision,
				} as never,
			),
		).rejects.toThrow("could not merge the chat's branch");
		expect(host.commands.filter((c) => c.includes("push.git"))).toHaveLength(2);
	} finally {
		warn.mockRestore();
	}
});

it("does not merge for a push that names an exact commit (an approved default-branch push)", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const host = hostWithPushes([rejected]);
		await expect(
			pushProxiedRepository(
				host as never,
				{
					...repository,
					commit: "b".repeat(40),
				} as never,
			),
		).rejects.toThrow("Workspace Git proxy transfer failed");
		expect(host.commands.filter((c) => c.includes("push.git"))).toHaveLength(1);
	} finally {
		warn.mockRestore();
	}
});
