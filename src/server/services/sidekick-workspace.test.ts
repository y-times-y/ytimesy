import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { localVms } from "./local-vms.testing";
import {
	markSidekickRoundStart,
	sidekickRoundChanges,
} from "./sidekick-workspace";

/**
 * Lead mode fusion's shared checkout, with real git in a local "VM": the
 * round's start and end are snapshots of the working tree; neither the
 * working tree, the index nor HEAD moves.
 */

let cleanup: string | undefined;
afterEach(() => {
	if (cleanup) rmSync(cleanup, { recursive: true, force: true });
});

const LEAD = WorkspaceId("parent");

describe("sidekick round snapshots in the lead's checkout", () => {
	it("lists a round's changes (untracked files included) and leaves the checkout as the sidekick left it", async () => {
		const vms = localVms();
		cleanup = vms.root;
		const repo = vms.parentRepo;
		// The lead's own uncommitted work before the round is not the round's.
		writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
		vms.git(repo, "add", "a.ts");
		const head = vms.git(repo, "rev-parse", "HEAD");
		const base = await markSidekickRoundStart({
			machines: vms.machines,
			vm: LEAD,
			label: "1",
			round: 2,
		});
		expect(
			vms.git(repo, "rev-parse", "refs/ytimesy/sidekick/1/round-2-start"),
		).toBe(base);
		// The sidekick edits a tracked file and adds one.
		writeFileSync(
			join(repo, "shared.ts"),
			"line 1\nline 2 (sidekick)\nline 3\n",
		);
		writeFileSync(join(repo, "new.ts"), "export const n = 1;\n");
		const changes = await sidekickRoundChanges({
			machines: vms.machines,
			vm: LEAD,
			label: "1",
			round: 2,
			base,
		});
		expect([...changes.files].sort()).toEqual(["new.ts", "shared.ts"]);
		expect(changes.stat).toContain("2 files changed");
		expect(
			vms.git(repo, "rev-parse", "refs/ytimesy/sidekick/1/round-2-end"),
		).toBe(changes.end);
		expect(vms.git(repo, "diff", "--name-only", base, changes.end)).toContain(
			"new.ts",
		);
		// HEAD, the index and the working tree are untouched.
		expect(vms.git(repo, "rev-parse", "HEAD")).toBe(head);
		expect(vms.git(repo, "diff", "--cached", "--name-only")).toBe("a.ts");
		expect(vms.git(repo, "status", "--porcelain")).toContain("?? new.ts");
		expect(readFileSync(join(repo, "shared.ts"), "utf8")).toContain(
			"(sidekick)",
		);
	});

	it("reports no files for a round that changed nothing", async () => {
		const vms = localVms();
		cleanup = vms.root;
		const base = await markSidekickRoundStart({
			machines: vms.machines,
			vm: LEAD,
			label: "1",
			round: 1,
		});
		const changes = await sidekickRoundChanges({
			machines: vms.machines,
			vm: LEAD,
			label: "1",
			round: 1,
			base,
		});
		expect(changes.files).toEqual([]);
		expect(changes.stat).toBe("");
	});
});
