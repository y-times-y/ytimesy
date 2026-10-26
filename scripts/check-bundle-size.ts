// Fails when the workspace page's first-load JS or CSS grows past its budget.
//
//   YTIMESY_TARGET=cloudflare pnpm build      # a production build in dist/
//   pnpm check:bundle                         # compare with scripts/bundle-budget.json
//   pnpm check:bundle --update                # record the current sizes as the baseline
//
// Sizes are gzipped bytes. A deliberate increase updates the baseline in the
// same change, so the review shows it.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type BundleBudget, checkBudget, measureBundle } from "./bundle-budget";

const { values } = parseArgs({
	options: {
		dist: { type: "string", default: "dist" },
		update: { type: "boolean", default: false },
	},
});
const budgetFile = resolve(import.meta.dirname, "bundle-budget.json");
const budget = JSON.parse(await readFile(budgetFile, "utf8")) as BundleBudget;
const current = await measureBundle(resolve(values.dist));

if (values.update) {
	await writeFile(
		budgetFile,
		`${JSON.stringify({ ...budget, baseline: current }, null, "\t")}\n`,
	);
	console.log("Recorded the baseline:", current);
	process.exit(0);
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const results = checkBudget(budget, current);
for (const result of results)
	console.log(
		`${result.over ? "OVER" : "ok  "} ${result.metric.padEnd(13)} ${kb(result.current).padStart(9)} gzip (baseline ${kb(result.baseline)}, limit ${kb(result.limit)}, +${budget.budgetPercent}%)`,
	);
if (results.some((result) => result.over)) {
	console.error(
		"The first-load bundle grew past its budget. Shrink it, or run `pnpm check:bundle --update` and commit the new baseline if the growth is intended.",
	);
	process.exit(1);
}
