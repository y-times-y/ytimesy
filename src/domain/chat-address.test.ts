import { expect, it } from "vitest";
import {
	chatAddress,
	chatAddressInput,
	chatAddressOutput,
	chatIdInAddress,
} from "./chat-address";

const id = "544c78fa-cc53-44fb-a963-30c58b0f0a93";
const href = (path: string) => new URL(path, "https://ytimesy.com");

it("reads the chat from /thread/<id> and from the older /?chat=<id>", () => {
	expect(chatIdInAddress({ pathname: `/thread/${id}`, search: "" })).toBe(id);
	expect(chatIdInAddress({ pathname: `/thread/${id}/`, search: "" })).toBe(id);
	expect(chatIdInAddress({ pathname: "/", search: `?chat=${id}` })).toBe(id);
	expect(chatIdInAddress({ pathname: "/", search: "" })).toBeNull();
	expect(chatIdInAddress({ pathname: "/thread/nope", search: "" })).toBeNull();
	expect(
		chatIdInAddress({ pathname: "/blog", search: `?chat=${id}` }),
	).toBeNull();
});

it("maps /thread/<id> to the page with that chat and back", () => {
	const input = chatAddressInput({
		url: href(`/thread/${id}?settings=plugins`),
	});
	expect(input?.pathname).toBe("/");
	expect(input?.searchParams.get("chat")).toBe(id);
	expect(input?.searchParams.get("settings")).toBe("plugins");
	const output = chatAddressOutput({
		url: href(`/?chat=${id}&settings=plugins`),
	});
	expect(output?.pathname).toBe(`/thread/${id}`);
	expect(output?.search).toBe("?settings=plugins");
});

it("leaves every other address alone", () => {
	for (const path of [
		"/",
		"/blog/harness",
		"/thread/not-an-id",
		"/?chat=nope",
	]) {
		expect(chatAddressInput({ url: href(path) })).toBeUndefined();
	}
	expect(chatAddressOutput({ url: href("/") })).toBeUndefined();
	expect(
		chatAddressOutput({ url: href(`/privacy?chat=${id}`) }),
	).toBeUndefined();
	expect(chatAddressOutput({ url: href("/?chat=nope") })).toBeUndefined();
});

it("builds the address of the open chat, keeping other parameters", () => {
	expect(chatAddress({ search: "", hash: "" }, id)).toBe(`/thread/${id}`);
	expect(chatAddress({ search: `?chat=${id}&project=p`, hash: "#x" }, id)).toBe(
		`/thread/${id}?project=p#x`,
	);
	expect(chatAddress({ search: `?chat=${id}`, hash: "" }, null)).toBe("/");
});
