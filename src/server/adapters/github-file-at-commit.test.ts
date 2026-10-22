import { beforeEach, expect, it, vi } from "vitest";

const getContent = vi.hoisted(() => vi.fn());
vi.mock("@octokit/rest", () => ({
	Octokit: class {
		repos = { getContent };
	},
}));
const { repositoryFileAtCommit } = await import("./github");

const commit = "a".repeat(40);
const read = () =>
	repositoryFileAtCommit("token", "acme/app", commit, ".ytimesy/hooks.json");
const notFound = (message: string) =>
	Object.assign(new Error(message), {
		status: 404,
		response: { data: { message } },
	});
beforeEach(() => {
	getContent.mockReset();
});

it("reads a regular file's content at the commit", async () => {
	getContent.mockResolvedValue({
		data: {
			type: "file",
			path: ".ytimesy/hooks.json",
			encoding: "base64",
			content: Buffer.from('{"version":1}').toString("base64"),
		},
	});
	expect(await read()).toEqual({ present: true, text: '{"version":1}' });
	expect(getContent).toHaveBeenCalledWith({
		owner: "acme",
		repo: "app",
		path: ".ytimesy/hooks.json",
		ref: commit,
	});
});

it("reports a path the commit does not have as absent", async () => {
	getContent.mockRejectedValue(notFound("Not Found"));
	expect(await read()).toEqual({ present: false });
});

it.each([
	[
		"a missing commit",
		() => Promise.reject(notFound("No commit found for the ref")),
	],
	[
		"a server error",
		() => Promise.reject(Object.assign(new Error(), { status: 502 })),
	],
	["a directory", () => Promise.resolve({ data: [] })],
	[
		"a symlink GitHub followed to its target",
		() =>
			Promise.resolve({
				data: {
					type: "file",
					path: "config/hooks.json",
					encoding: "base64",
					content: "",
				},
			}),
	],
	[
		"a submodule",
		() =>
			Promise.resolve({
				data: { type: "submodule", path: ".ytimesy/hooks.json" },
			}),
	],
	[
		"a file too large to inline",
		() =>
			Promise.resolve({
				data: {
					type: "file",
					path: ".ytimesy/hooks.json",
					encoding: "none",
					content: "",
				},
			}),
	],
])("cannot say for %s", async (_case, answer) => {
	getContent.mockImplementation(answer);
	expect(await read()).toBeNull();
});

it("never asks GitHub for a ref that is not a commit id", async () => {
	expect(
		await repositoryFileAtCommit("token", "acme/app", "main", "a.json"),
	).toBeNull();
	expect(getContent).not.toHaveBeenCalled();
});
