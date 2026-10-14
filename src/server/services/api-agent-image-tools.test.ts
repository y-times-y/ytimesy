import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, expect, it } from "vitest";
import { AGENT_ATTACHMENT_DIRECTORY } from "#/domain/message-attachment";
import { localHarnessWorkspace } from "../../../tests/helpers/local-harness-workspace";
import { apiAgentImageTools } from "./api-agent-image-tools";

const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function fixture() {
	const workspace = await localHarnessWorkspace();
	cleanups.push(workspace.cleanup);
	const tools = apiAgentImageTools({
		...workspace.workspace,
		signal: new AbortController().signal,
	});
	const image = tools.view_image;
	const execute = image.execute;
	const toModelOutput = image.toModelOutput;
	if (!execute || !toModelOutput) throw new Error("Image tool missing");
	const call = (path: string) =>
		execute({ path }, { toolCallId: "image", messages: [], context: {} });
	return { ...workspace, toModelOutput, call, tools };
}

it("reads actual repository pixels and emits image content, not JSON-only base64", async () => {
	const { root, call, toModelOutput } = await fixture();
	await writeFile(join(root, "screenshot.dat"), Buffer.from(png, "base64"));
	const output = await call("screenshot.dat");
	expect(output).toMatchObject({
		path: "screenshot.dat",
		mediaType: "image/png",
		base64: png,
	});
	const converted = await toModelOutput({
		toolCallId: "image",
		input: { path: "screenshot.dat" },
		output,
	});
	expect(converted).toMatchObject({
		type: "content",
		value: [
			{ type: "text" },
			{
				type: "file",
				mediaType: "image/png",
				data: { type: "data", data: png },
			},
		],
	});
});

it("rejects traversal, symlink files/parents, nonimages and oversized files", async () => {
	const { root, call } = await fixture();
	await writeFile(join(root, "image.png"), Buffer.from(png, "base64"));
	await symlink("image.png", join(root, "link.png"));
	await mkdir(join(root, "assets"));
	await symlink("assets", join(root, "linked-assets"));
	await writeFile(
		join(root, "assets", "image.png"),
		Buffer.from(png, "base64"),
	);
	await writeFile(join(root, "fake.png"), "<svg>not a raster image</svg>");
	await writeFile(join(root, "large.png"), Buffer.alloc(3000001));
	for (const path of [
		"../image.png",
		"/etc/passwd",
		".git/config",
		"link.png",
		"linked-assets/image.png",
		"fake.png",
		"large.png",
		"assets",
	])
		await expect(call(path)).rejects.toThrow();
});

it("honors cancellation before reading pixels", async () => {
	const { workspace } = await fixture();
	const signal = AbortSignal.abort();
	const tool = apiAgentImageTools({ ...workspace, signal }).view_image;
	if (!tool.execute) throw new Error("Image tool missing");
	await expect(
		tool.execute(
			{ path: "image.png" },
			{ toolCallId: "aborted", messages: [], context: {} },
		),
	).rejects.toThrow();
});

it("delivers pixels into the next SDK model request", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "screenshot.png"), Buffer.from(png, "base64"));
	let requests = 0;
	const model = new MockLanguageModelV4({
		doGenerate: async () => ({
			content:
				requests++ === 0
					? [
							{
								type: "tool-call",
								toolCallId: "image",
								toolName: "view_image",
								input: '{"path":"screenshot.png"}',
							},
						]
					: [{ type: "text", text: "Image received" }],
			finishReason: {
				unified: requests === 1 ? "tool-calls" : "stop",
				raw: "stop",
			},
			usage: {
				inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 0, text: 0, reasoning: 0 },
			},
			warnings: [],
		}),
	});
	await generateText({
		model,
		tools,
		prompt: "Inspect the screenshot",
		stopWhen: isStepCount(2),
	});
	expect(model.doGenerateCalls).toHaveLength(2);
	expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain(
		'"type":"file"',
	);
	expect(JSON.stringify(model.doGenerateCalls[1].prompt)).toContain(png);
});

it("reads an attached image by its absolute path and nothing else outside the repository", async () => {
	const { call } = await fixture();
	const id = crypto.randomUUID();
	const directory = join(AGENT_ATTACHMENT_DIRECTORY, id);
	await mkdir(directory, { recursive: true });
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "shot.png"), Buffer.from(png, "base64"));
	await symlink("shot.png", join(directory, "link.png"));
	await expect(call(`${directory}/shot.png`)).resolves.toMatchObject({
		path: `${id}/shot.png`,
		mediaType: "image/png",
	});
	for (const path of [
		`${directory}/link.png`,
		`${directory}/../${id}/shot.png`,
		`${directory}/missing.png`,
		`${AGENT_ATTACHMENT_DIRECTORY}/not-an-id/shot.png`,
		`${AGENT_ATTACHMENT_DIRECTORY}/${id}`,
		`${directory}/nested/shot.png`,
		"/tmp/other/shot.png",
	])
		await expect(call(path)).rejects.toThrow();
});
