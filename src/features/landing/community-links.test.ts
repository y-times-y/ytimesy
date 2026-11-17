import { expect, it } from "vitest";
import { DISCORD_URL } from "./community-links";

it("links to a real Discord invite, not the placeholder", () => {
	expect(DISCORD_URL).toMatch(
		/^https:\/\/discord\.(gg|com\/invite)\/[A-Za-z0-9-]+$/,
	);
	expect(DISCORD_URL).not.toContain("REPLACE");
});
