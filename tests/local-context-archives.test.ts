import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { localContextArchives } from "../benchmarks/evaluation/local-context-archives";
import {
	archiveModelContext,
	readModelContextArchive,
	searchModelContextArchives,
} from "../src/server/adapters/context-archives";

it("round-trips encrypted evidence, searches it, rejects another owner, and cleans up without networking", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-local-archive-"));
	const network = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("Network forbidden"));
	const archives = localContextArchives(
		directory,
		"actual-operator",
		"pilot-chat",
	);
	try {
		const messages = [
			{
				role: "user" as const,
				content: "Inspect the billing calculation before editing.",
			},
		];
		const reference = await archiveModelContext(
			"actual-operator",
			"pilot-chat",
			messages,
			archives.storage,
		);
		expect(
			await readModelContextArchive(
				"actual-operator",
				"pilot-chat",
				reference,
				archives.storage,
			),
		).toEqual(messages);
		const bytes = await readFile(
			join(directory, (await readdir(directory))[0]),
			"utf8",
		);
		expect(bytes).not.toContain("billing calculation");
		const result = await searchModelContextArchives(
			"actual-operator",
			"pilot-chat",
			"billing",
			0,
			new AbortController().signal,
			0,
			[],
			archives.storage,
		);
		expect(result.matches).toHaveLength(1);
		await expect(
			readModelContextArchive(
				"different-owner",
				"pilot-chat",
				reference,
				archives.storage,
			),
		).rejects.toThrow("ownership");
		await archives.close();
		expect(await readdir(directory)).toEqual([]);
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
		await rm(directory, { recursive: true });
	}
});
