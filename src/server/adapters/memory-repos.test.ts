import { describe, expect, it } from "vitest";
import {
	type ArtifactsNamespace,
	artifactsCode,
	memoryRepo,
	registerMemoryRepos,
} from "./memory-repos";

describe("artifactsCode", () => {
	it("reads the code a native binding sets", () => {
		expect(
			artifactsCode(Object.assign(new Error("x"), { code: "NOT_FOUND" })),
		).toBe("NOT_FOUND");
	});

	it("reads it from the message a remote binding passes (local dev)", () => {
		expect(
			artifactsCode(
				new Error("ArtifactsError: Repository not found: memory-eval-1."),
			),
		).toBe("NOT_FOUND");
		expect(
			artifactsCode(new Error("ArtifactsError: Repository already exists.")),
		).toBe("ALREADY_EXISTS");
		expect(artifactsCode(new Error("internal error"))).toBeUndefined();
	});
});

describe("a user without a memory repo yet", () => {
	it("reads as empty memory, not an error", async () => {
		const missing = () =>
			Promise.reject(
				new Error("ArtifactsError: Repository not found: memory-u1."),
			);
		registerMemoryRepos({
			get: missing,
			create: missing,
			delete: missing,
		} as unknown as ArtifactsNamespace);
		const repo = memoryRepo("memory-u1");
		await expect(repo?.snapshot()).resolves.toEqual({ head: null, files: {} });
		await expect(repo?.history("notes.md")).resolves.toEqual([]);
		await expect(repo?.destroy()).resolves.toBeUndefined();
	});
});
