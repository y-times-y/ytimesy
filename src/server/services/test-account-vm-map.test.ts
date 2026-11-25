import { expect, it } from "vitest";
import { mapVmSlugs } from "./test-account-vm-map";

it("labels a slug no row names as unreferenced, with no ids", async () => {
	const result = await mapVmSlugs(
		{ query: async () => ({ rows: [] }) as never },
		["ytimesy-ag-0123456789abcdef"],
	);
	expect(result).toEqual([
		{
			slug: "ytimesy-ag-0123456789abcdef",
			kind: "unreferenced",
			owner: "none",
			chatArchived: null,
			projectArchived: null,
			idleDays: null,
			buildStatus: null,
		},
	]);
});

it("labels a chat machine by owner kind and archive state only", async () => {
	const result = await mapVmSlugs(
		{
			query: async () =>
				({
					rows: [
						{
							user_id: "ytimesy-test-account",
							archived: true,
							project_archived: false,
							idle: "9.04",
						},
					],
				}) as never,
		},
		["ytimesy-ag-0123456789abcdef"],
	);
	expect(result[0]).toMatchObject({
		kind: "chat",
		owner: "test",
		chatArchived: true,
		idleDays: 9,
	});
	expect(JSON.stringify(result)).not.toContain("user_id");
});
