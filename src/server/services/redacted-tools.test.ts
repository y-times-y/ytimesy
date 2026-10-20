import type { ToolSet } from "ai";
import { expect, it } from "vitest";
import { withRedactedResults } from "./redacted-tools";

const options = { toolCallId: "call", messages: [], context: {} };

it("redacts runtime secret values from tool results and errors", async () => {
	const tools = withRedactedResults(
		{
			bash: { execute: async () => ({ stdout: "token=ghs_secretvalue99\n" }) },
			fail: {
				execute: async () => {
					throw new Error("bad key ghs_secretvalue99");
				},
			},
		} as unknown as ToolSet,
		["ghs_secretvalue99"],
	);
	await expect(tools.bash?.execute?.({}, options)).resolves.toEqual({
		stdout: "token=[REDACTED]\n",
	});
	await expect(tools.fail?.execute?.({}, options)).rejects.toThrow(
		"bad key [REDACTED]",
	);
});

it("redacts values added to the list after the tools were wrapped", async () => {
	const secrets: string[] = [];
	const tools = withRedactedResults(
		{
			bash: { execute: async () => "Authorization: Bearer art_memorytoken1" },
		} as unknown as ToolSet,
		secrets,
	);
	await expect(tools.bash?.execute?.({}, options)).resolves.toBe(
		"Authorization: Bearer art_memorytoken1",
	);
	secrets.push("art_memorytoken1");
	await expect(tools.bash?.execute?.({}, options)).resolves.toBe(
		"Authorization: Bearer [REDACTED]",
	);
});
