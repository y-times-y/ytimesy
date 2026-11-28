import { describe, expect, it } from "vitest";
import { markdownImageSource } from "./markdown-image";

describe("markdownImageSource", () => {
	it("resolves relative paths against the Markdown file's folder", () => {
		const at = (src: string) =>
			markdownImageSource("docs/guide/README.md", src);
		expect(at("img/a.png")).toEqual({
			kind: "workspace",
			path: "docs/guide/img/a.png",
		});
		expect(at("./a%20b.png?raw=true")).toEqual({
			kind: "workspace",
			path: "docs/guide/a b.png",
		});
		expect(at("../logo.png")).toEqual({
			kind: "workspace",
			path: "docs/logo.png",
		});
		expect(at("/assets/logo.png")).toEqual({
			kind: "workspace",
			path: "assets/logo.png",
		});
	});
	it("keeps web images and refuses escapes and other schemes", () => {
		expect(markdownImageSource("README.md", "https://x.test/a.png")).toEqual({
			kind: "external",
			url: "https://x.test/a.png",
		});
		expect(markdownImageSource("README.md", "../secret.png")).toBeNull();
		expect(markdownImageSource("README.md", "javascript:alert(1)")).toBeNull();
		expect(markdownImageSource("README.md", "//evil.test/a.png")).toBeNull();
	});
});
