import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
	r2Configuration,
	r2DeletePrefix,
	r2GetObject,
	r2PutObject,
	r2Request,
	signedR2Headers,
} from "./r2";

const account = "0123456789abcdef0123456789abcdef";
const credentials = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	now: new Date("2026-10-10T23:26:13Z"),
};
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

// Expected signatures were produced by botocore's S3SigV4Auth (region "auto").
it("signs uploads and listings exactly as AWS Signature V4 does", () => {
	expect(
		signedR2Headers({
			method: "PUT",
			url: new URL(
				`https://${account}.r2.cloudflarestorage.com/ytimesy-checkpoints/abc/def/context-1.enc`,
			),
			body: "ciphertext",
			...credentials,
		}).authorization,
	).toBe(
		"AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261010/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=2c386f01af8a94f21640322100e86217ace8771aa30b9f222f193e8d96804955",
	);
	const listing = new URL(
		`https://${account}.r2.cloudflarestorage.com/ytimesy-checkpoints`,
	);
	listing.searchParams.set("list-type", "2");
	listing.searchParams.set("prefix", "abc/def/context-");
	listing.searchParams.set("max-keys", "1000");
	expect(
		signedR2Headers({ method: "GET", url: listing, body: "", ...credentials })
			.authorization,
	).toContain(
		"Signature=c5527c4aaa4a5d80a488847f6b5ca018ce00a6ea9982aaae4d78db868e635256",
	);
});

it("is unused when unset and refuses partial configuration", () => {
	expect(r2Configuration()).toBeNull();
	vi.stubEnv("R2_ACCOUNT_ID", account);
	expect(() => r2Configuration()).toThrow("misconfigured");
});

it("serves the storage adapter's calls from R2 with unchanged object paths", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		const url = new URL(String(input));
		if (init?.method === "GET" && url.searchParams.get("list-type"))
			return new Response(
				"<ListBucketResult><Key>p/context-b.enc</Key><Key>p/context-a.enc</Key><IsTruncated>false</IsTruncated></ListBucketResult>",
			);
		return new Response(init?.method === "GET" ? "stored" : "");
	});
	vi.stubGlobal("fetch", fetch);
	const config = { accountId: account, bucket: "ytimesy-dev", ...credentials };
	await r2Request(
		config,
		"ytimesy-checkpoints",
		"object/ytimesy-checkpoints/p/x.enc",
		{
			method: "POST",
			body: "sealed",
		},
	);
	expect(String(fetch.mock.calls[0][0])).toBe(
		`https://${account}.r2.cloudflarestorage.com/ytimesy-dev/p/x.enc`,
	);
	expect(fetch.mock.calls[0][1]?.method).toBe("PUT");
	const read = await r2Request(
		config,
		"ytimesy-checkpoints",
		"object/ytimesy-checkpoints/p/x.enc",
		{},
	);
	expect(await read.text()).toBe("stored");
	const listed = await r2Request(
		config,
		"ytimesy-checkpoints",
		"object/list/ytimesy-checkpoints",
		{
			method: "POST",
			body: JSON.stringify({
				prefix: "p/",
				search: "context-",
				offset: 0,
				limit: 3,
			}),
		},
	);
	expect(await listed.json()).toEqual([
		{ name: "context-a.enc" },
		{ name: "context-b.enc" },
	]);
	await r2Request(config, "ytimesy-checkpoints", "object/ytimesy-checkpoints", {
		method: "DELETE",
		body: JSON.stringify({ prefixes: ["p/x.enc"] }),
	});
	expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
});

it("stores and reads binary evidence objects, with ranges for seeking", async () => {
	const calls: { method: string; url: URL; headers: Headers; body: unknown }[] =
		[];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof globalThis.fetch>(async (input, init) => {
			calls.push({
				method: String(init?.method),
				url: new URL(String(input)),
				headers: new Headers(init?.headers),
				body: init?.body,
			});
			return new Response("part", {
				status: init?.method === "GET" ? 206 : 200,
			});
		}),
	);
	const config = { accountId: account, bucket: "ytimesy-dev", ...credentials };
	const bytes = new Uint8Array([0, 255, 1, 2]);
	await r2PutObject(
		config,
		"pr-evidence/u/p/e/recording.webm",
		bytes,
		"video/webm",
	);
	expect(calls[0].method).toBe("PUT");
	expect(calls[0].url.pathname).toBe(
		"/ytimesy-dev/pr-evidence/u/p/e/recording.webm",
	);
	expect(calls[0].headers.get("content-type")).toBe("video/webm");
	// The signature covers the exact binary payload.
	expect(calls[0].headers.get("x-amz-content-sha256")).toBe(
		createHash("sha256").update(bytes).digest("hex"),
	);
	expect(new Uint8Array(await (calls[0].body as Blob).arrayBuffer())).toEqual(
		bytes,
	);
	const read = await r2GetObject(
		config,
		"pr-evidence/u/p/e/recording.webm",
		"bytes=0-1",
	);
	expect(read.status).toBe(206);
	expect(calls[1].headers.get("range")).toBe("bytes=0-1");
});

it("deletes every object under a scoped prefix and refuses an unscoped one", async () => {
	const deleted: string[] = [];
	let listed = false;
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = new URL(String(input));
			if (init?.method === "GET") {
				const keys = listed
					? []
					: ["pr-evidence/u/a.png", "pr-evidence/u/b.webm"];
				listed = true;
				return new Response(
					`<ListBucketResult>${keys.map((key) => `<Key>${key}</Key>`).join("")}<IsTruncated>false</IsTruncated></ListBucketResult>`,
				);
			}
			deleted.push(url.pathname);
			return new Response(null, { status: 204 });
		}),
	);
	const config = { accountId: account, bucket: "ytimesy-dev", ...credentials };
	expect(await r2DeletePrefix(config, "pr-evidence/u/")).toBe(2);
	expect(deleted).toEqual([
		"/ytimesy-dev/pr-evidence/u/a.png",
		"/ytimesy-dev/pr-evidence/u/b.webm",
	]);
	await expect(r2DeletePrefix(config, "")).rejects.toThrow("unscoped");
	await expect(r2DeletePrefix(config, "pr-evidence")).rejects.toThrow(
		"unscoped",
	);
});

it("presigns URLs as AWS's Signature V4 reference example does", async () => {
	const { presignedS3Url } = await import("./r2");
	const url = presignedS3Url({
		method: "GET",
		url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
		region: "us-east-1",
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		expiresSeconds: 86400,
		now: new Date("2013-05-24T00:00:00Z"),
	});
	expect(url).toBe(
		"https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
	);
});

it("presigns one R2 object for at most an hour, refusing keys that escape", async () => {
	const { presignedR2Url } = await import("./r2");
	const config = {
		accountId: "a".repeat(32),
		accessKeyId: "id",
		secretAccessKey: "secret",
		bucket: "ytimesy-dev",
	};
	const url = new URL(
		presignedR2Url({
			config,
			method: "PUT",
			key: "dependency-cache/v1/x.tar",
			expiresSeconds: 99_999,
		}),
	);
	expect(url.host).toBe(`${"a".repeat(32)}.r2.cloudflarestorage.com`);
	expect(url.pathname).toBe("/ytimesy-dev/dependency-cache/v1/x.tar");
	expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
	expect(() =>
		presignedR2Url({
			config,
			method: "GET",
			key: "../other",
			expiresSeconds: 60,
		}),
	).toThrow("Invalid R2 object key.");
});
