import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filePreviewKind } from "../src/domain/file-preview";
import { filePreviewCommand } from "../src/server/services/file-preview-command";

describe("bounded checkout preview reader", () => {
	let root: string;
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	const read = (path: string, revision: "head" | "working" = "working") =>
		JSON.parse(
			execSync(filePreviewCommand(root, path, revision), {
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
			}),
		);
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "file-preview-test-"));
		git("init");
		writeFileSync(join(root, "README.md"), "# Before\n");
		git("add", "README.md");
		git(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-m",
			"fixture",
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	it("reads full HEAD and working-tree documents independently", () => {
		writeFileSync(join(root, "README.md"), "# After\n");
		expect(read("README.md", "head")).toEqual({
			kind: "text",
			text: "# Before\n",
		});
		expect(read("README.md")).toEqual({ kind: "text", text: "# After\n" });
	});
	it("encodes binary images without decoding as UTF-8", () => {
		const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
		writeFileSync(join(root, "image.png"), bytes);
		expect(read("image.png")).toEqual({
			kind: "image",
			dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
		});
	});
	it("returns explicit absence for added and deleted versions", () => {
		writeFileSync(join(root, "new.md"), "new");
		expect(read("new.md", "head").kind).toBe("unavailable");
		rmSync(join(root, "README.md"));
		expect(read("README.md").kind).toBe("unavailable");
		expect(read("README.md", "head").kind).toBe("text");
	});
	it("rejects traversal, outside symlinks, and git metadata", () => {
		symlinkSync(tmpdir(), join(root, "outside"));
		for (const path of ["../secret", "outside/secret", ".git/config"])
			expect(read(path).kind).toBe("unavailable");
	});
	it("rejects oversize text instead of showing a silently truncated document", () => {
		writeFileSync(join(root, "large.md"), "x".repeat(200001));
		expect(read("large.md")).toMatchObject({ kind: "unavailable" });
	});
	it("quotes filenames instead of interpreting shell syntax", () => {
		const path = "file'; echo hacked; #.md";
		writeFileSync(join(root, path), "safe");
		expect(read(path)).toEqual({ kind: "text", text: "safe" });
	});
	it("classifies previewable types without treating code as markup", () => {
		expect(filePreviewKind("README.MD")).toBe("markdown");
		expect(filePreviewKind("icon.svg")).toBe("svg");
		expect(filePreviewKind("photo.png")).toBe("image");
		expect(filePreviewKind("index.html")).toBe("code");
	});
});
