import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

/** Writes the split-chat markup for scripts/measure-composers.ts; skipped otherwise. */
it.skipIf(!process.env.SPLIT_CHAT_OUT)(
	"renders the split chat",
	async () => {
		const { renderSplitChat } = await import("./preview-demo");
		const out = process.env.SPLIT_CHAT_OUT as string;
		writeFileSync(`${out}.row.html`, renderSplitChat(false));
		writeFileSync(`${out}.stacked.html`, renderSplitChat(true));
		expect(out).toBeTruthy();
	},
	120_000,
);
