import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceRecord } from "#/domain/pr-evidence";
import {
	type EvidenceStore,
	evidenceObjectKey,
} from "../adapters/pr-evidence-store";

vi.mock("../auth/auth", () => ({ requireUser: vi.fn() }));

import { serveEvidenceMedia } from "./pr-evidence-media";

const projectId = "0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const evidenceId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const video = Buffer.from("0123456789abcdefghij");

const record = {
	id: evidenceId,
	projectId,
	files: [
		{ name: "recording.webm", bytes: video.length, sha256: "a".repeat(64) },
		{ name: "01-home.png", bytes: 3, sha256: "b".repeat(64) },
	],
} as unknown as EvidenceRecord;

/** R2's answers to plain and ranged reads of the stored video. */
function storeOf(objects: Record<string, Buffer>): EvidenceStore & {
	get: ReturnType<typeof vi.fn>;
} {
	return {
		put: vi.fn(),
		removePrefix: vi.fn(),
		get: vi.fn(async (key: string, range?: string | null) => {
			const data = objects[key];
			if (!data) return new Response("<Error/>", { status: 404 });
			if (!range)
				return new Response(new Uint8Array(data), {
					status: 200,
					headers: { "content-length": String(data.length), etag: '"e1"' },
				});
			const [, from, to] = /^bytes=(\d*)-(\d*)$/.exec(range) ?? [];
			const start = Number(from);
			if (start >= data.length)
				return new Response(null, {
					status: 416,
					headers: { "content-range": `bytes */${data.length}` },
				});
			const end = to ? Math.min(Number(to), data.length - 1) : data.length - 1;
			return new Response(new Uint8Array(data.subarray(start, end + 1)), {
				status: 206,
				headers: {
					"content-length": String(end - start + 1),
					"content-range": `bytes ${start}-${end}/${data.length}`,
				},
			});
		}),
	};
}

let store: ReturnType<typeof storeOf>;
let owner: ReturnType<typeof vi.fn>;
let user: ReturnType<typeof vi.fn>;
const deps = () =>
	({ user, record: owner, store }) as unknown as Parameters<
		typeof serveEvidenceMedia
	>[2];
const params = (file = "recording.webm") => ({
	projectId,
	evidenceId,
	file,
});
const get = (headers: Record<string, string> = {}, method = "GET") =>
	new Request(
		`https://app.ytimesy.test/api/projects/${projectId}/evidence/${evidenceId}/recording.webm`,
		{ method, headers },
	);

beforeEach(() => {
	store = storeOf({
		[evidenceObjectKey(
			{ userId: "alice", projectId },
			evidenceId,
			"recording.webm",
		)]: video,
	});
	user = vi.fn(async () => ({ id: "alice" }));
	owner = vi.fn(async (userId: string, project: string, id: string) =>
		userId === "alice" && project === projectId && id === evidenceId
			? record
			: null,
	);
});

describe("evidence media route", () => {
	it("asks for sign-in without reading anything", async () => {
		user.mockRejectedValue(new Response("Sign in required", { status: 401 }));
		const response = await serveEvidenceMedia(get(), params(), deps());
		expect(response.status).toBe(401);
		expect(owner).not.toHaveBeenCalled();
		expect(store.get).not.toHaveBeenCalled();
	});

	it("answers 404 to a signed-in user without access, like a missing capture", async () => {
		user.mockResolvedValue({ id: "mallory" });
		const response = await serveEvidenceMedia(get(), params(), deps());
		expect(response.status).toBe(404);
		expect(owner).toHaveBeenCalledWith("mallory", projectId, evidenceId);
		expect(store.get).not.toHaveBeenCalled();
	});

	it("serves only files the capture stored, by validated name", async () => {
		for (const file of ["manifest.json", "../x.png", "index.html", "02-x.png"])
			expect(
				(await serveEvidenceMedia(get(), params(file), deps())).status,
			).toBe(404);
		expect(
			(
				await serveEvidenceMedia(
					get(),
					{ ...params(), projectId: "not-a-uuid" },
					deps(),
				)
			).status,
		).toBe(404);
		expect(store.get).not.toHaveBeenCalled();
	});

	it("streams the whole file privately with nosniff and no shared caching", async () => {
		const response = await serveEvidenceMedia(get(), params(), deps());
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(video);
		expect(Object.fromEntries(response.headers)).toMatchObject({
			"content-type": "video/webm",
			"content-length": String(video.length),
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
			"cross-origin-resource-policy": "same-origin",
			"accept-ranges": "bytes",
		});
	});

	it("answers a byte range with 206 for video seeking", async () => {
		const response = await serveEvidenceMedia(
			get({ range: "bytes=5-9" }),
			params(),
			deps(),
		);
		expect(store.get).toHaveBeenCalledWith(expect.any(String), "bytes=5-9");
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 5-9/20");
		expect(await response.text()).toBe("56789");
		const open = await serveEvidenceMedia(
			get({ range: "bytes=15-" }),
			params(),
			deps(),
		);
		expect(open.status).toBe(206);
		expect(await open.text()).toBe("fghij");
	});

	it("passes 416 through and ignores ranges it does not support", async () => {
		const beyond = await serveEvidenceMedia(
			get({ range: "bytes=50-60" }),
			params(),
			deps(),
		);
		expect(beyond.status).toBe(416);
		expect(beyond.headers.get("content-range")).toBe("bytes */20");
		const multi = await serveEvidenceMedia(
			get({ range: "bytes=0-1,4-5" }),
			params(),
			deps(),
		);
		expect(store.get).toHaveBeenLastCalledWith(expect.any(String), null);
		expect(multi.status).toBe(200);
	});

	it("reads the signed-in owner's own object key only", async () => {
		await serveEvidenceMedia(get(), params(), deps());
		expect(store.get).toHaveBeenCalledWith(
			evidenceObjectKey(
				{ userId: "alice", projectId },
				evidenceId,
				"recording.webm",
			),
			null,
		);
	});

	it("answers HEAD without a body and refuses other methods", async () => {
		const head = await serveEvidenceMedia(get({}, "HEAD"), params(), deps());
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		const post = await serveEvidenceMedia(get({}, "POST"), params(), deps());
		expect(post.status).toBe(405);
	});

	it("answers 404 when the object is gone from storage", async () => {
		store = storeOf({});
		expect((await serveEvidenceMedia(get(), params(), deps())).status).toBe(
			404,
		);
	});
});
