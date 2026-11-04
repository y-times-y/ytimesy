import { Effect, Exit } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceId } from "#/domain/ids";
import type { ProjectCheckout } from "#/domain/project-checkout";
import { ensureProjectCheckout } from "./project-workspace";
import type { WorkspaceMachines } from "./workspace-machines";

const transfer = vi.hoisted(() => ({ failing: false }));
const receive = vi.hoisted(() => vi.fn());
vi.mock("#/server/adapters/github/git-broker", () => ({
	receiveBrokeredRepository: async (...args: unknown[]) => {
		receive(...args);
		if (transfer.failing) throw new Error("GitHub transfer failed.");
		return "updated";
	},
}));

const checkout: ProjectCheckout = {
	owner: "acme",
	name: "app",
	fullName: "acme/app",
	branch: "main",
	workingBranch: "ytimesy/new-chat-1",
	installationId: "1",
	preserveCurrentBranch: true,
};
/** A reused template checkout whose current branch is `current`. */
function machines(current: string) {
	return {
		exec: vi.fn(async (_vm: unknown, command: string) => ({
			exitCode: 0,
			stdout: command.includes("branch --show-current")
				? `${current}\n`
				: "present\n/home/ubuntu/app\n",
			stderr: "",
		})),
		writeTextFile: vi.fn(async () => undefined),
	} as unknown as WorkspaceMachines;
}
const run = (host: WorkspaceMachines, planned: ProjectCheckout) =>
	Effect.runPromise(ensureProjectCheckout(host, "vm" as WorkspaceId, planned));

beforeEach(() => {
	receive.mockReset();
	transfer.failing = false;
});

it("fetches a pinned revision even when the checkout is already on its branch", async () => {
	const pinned = { ...checkout, pinnedRevision: "b".repeat(40) };
	await run(machines(checkout.workingBranch), checkout);
	expect(receive).not.toHaveBeenCalled();
	await run(machines(checkout.workingBranch), pinned);
	expect(receive).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ pinnedRevision: pinned.pinnedRevision }),
	);
});

it("clones on a machine booted without the template and names the primary checkout as the chat's directory", async () => {
	const host = {
		exec: vi.fn(async (_vm: unknown, command: string) => ({
			exitCode: 0,
			stdout: command.includes("printf") ? "/home/ubuntu" : "",
			stderr: "",
		})),
		writeTextFile: vi.fn(async () => undefined),
	} as unknown as WorkspaceMachines;
	const primary = await run(host, {
		...checkout,
		preserveCurrentBranch: false,
		additionalRepositories: [
			{ ...checkout, name: "api", fullName: "acme/api" },
		],
	});
	expect(primary).toBe("/home/ubuntu/app");
	expect(receive).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ mode: "clone", destination: "/home/ubuntu/app" }),
	);
	const written = vi.mocked(host.writeTextFile).mock.calls as unknown[][];
	expect(written.at(-1)).toEqual([
		"vm",
		"/tmp/ytimesy-project-cwd",
		"/home/ubuntu/app\n",
	]);
});

it("fails instead of keeping a stale checkout when a pinned update fails", async () => {
	transfer.failing = true;
	const outcome = (pinnedRevision?: string) =>
		Effect.runPromiseExit(
			ensureProjectCheckout(
				machines(checkout.workingBranch),
				"vm" as WorkspaceId,
				{
					...checkout,
					preserveCurrentBranch: false,
					pinnedRevision,
				},
			),
		);
	// Unpinned, a failed fast-forward keeps the checkout as it was.
	expect(Exit.isSuccess(await outcome())).toBe(true);
	expect(Exit.isFailure(await outcome("b".repeat(40)))).toBe(true);
});
