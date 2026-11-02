import { describe, expect, it } from "vitest";
import {
	blockColumns,
	blockHue,
	CELL,
	CELL_GAP,
	memoryBlocks,
	PERSONAL_HUE,
	recencyTint,
} from "./memory-graph";
import { memoryRows, PERSONAL_SCOPE } from "./memory-overview";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const WEB = "projects/acme-web--7";
const CLI = "projects/tools-cli--9";
const files = {
	"MEMORY.md": `# Memory\n\n## Index\n- [[${WEB}/api]]\n- [[personal/style]]\n`,
	[`${WEB}/api.md`]: `# API\n\n- New webhook events go to v1 [superseded-by: /?chat=${B}; source: /?chat=${A}; added: 2026-10-01]\n- Errors are problem+json [source: /?chat=${A}; added: 2026-10-16]\n- New webhook events go to v2 only [source: /?chat=${B}; added: 2026-10-18]\n`,
	"personal/style.md":
		"# Style\n\n- Beta flag stays on [expires: 2026-10-28; source: manual; added: 2026-09-01]\n- Uses tabs\n",
	[`${CLI}/build.md`]:
		"# Build\n\n- Always pnpm [scope: always; kind: inferred; added: 2026-08-01]\n",
};
const today = "2026-10-21";
const rows = memoryRows(files, today);
const step = CELL + CELL_GAP;

describe("memory blocks", () => {
	it("makes one block per folder: Personal first, then each project by name", () => {
		const blocks = memoryBlocks({ rows, today });
		expect(blocks.map((block) => block.scope)).toEqual([
			PERSONAL_SCOPE,
			"project:acme-web--7",
			"project:tools-cli--9",
		]);
		expect(blocks.flatMap((block) => block.cells)).toHaveLength(6);
		// By display name, not by folder key.
		const names: Record<string, string> = {
			"project:acme-web--7": "Website",
			"project:tools-cli--9": "CLI",
		};
		expect(
			memoryBlocks({ rows, today, name: (scope) => names[scope] ?? scope }).map(
				(block) => block.scope,
			),
		).toEqual([PERSONAL_SCOPE, "project:tools-cli--9", "project:acme-web--7"]);
	});

	it("puts lines in use first, newest first, then archived ones, on a fixed grid", () => {
		const [, web] = memoryBlocks({ rows, today });
		expect(web.cells.map((cell) => cell.row.text)).toEqual([
			"New webhook events go to v2 only",
			"Errors are problem+json",
			"New webhook events go to v1",
		]);
		expect(web.cells.map((cell) => [cell.x, cell.y])).toEqual([
			[0, 0],
			[step, 0],
			[2 * step, 0],
		]);
		expect(web.columns).toBe(5);
		expect(web.width).toBe(5 * step - CELL_GAP);
		expect(web.height).toBe(CELL);
		expect(web).toMatchObject({ active: 2, fresh: 2, newest: "2026-10-18" });
	});

	it("marks pinned, inferred, archived and new, and what replaced what", () => {
		const cells = memoryBlocks({ rows, today }).flatMap((block) => block.cells);
		const byText = (text: string) =>
			cells.find((cell) => cell.row.text.startsWith(text));
		expect(byText("New webhook events go to v1")).toMatchObject({
			archived: true,
			fresh: false,
			replacedBy: `${WEB}/api.md:5`,
		});
		expect(byText("New webhook events go to v2")).toMatchObject({
			archived: false,
			fresh: true,
			age: 3,
			replaces: `${WEB}/api.md:3`,
		});
		expect(byText("Always pnpm")).toMatchObject({
			pinned: true,
			inferred: true,
		});
		expect(byText("Uses tabs")).toMatchObject({ age: null, tint: 0.1 });
	});

	it("is deterministic and brightens newer cells", () => {
		expect(memoryBlocks({ rows, today })).toEqual(
			memoryBlocks({ rows: [...rows], today }),
		);
		expect(recencyTint(0)).toBeCloseTo(0.65);
		expect(recencyTint(100)).toBeGreaterThan(recencyTint(150));
		expect(recencyTint(400)).toBeCloseTo(0.1);
	});

	it("widens big blocks up to ten columns, which still fit a phone", () => {
		expect(blockColumns(0)).toBe(5);
		expect(blockColumns(25)).toBe(5);
		expect(blockColumns(49)).toBe(7);
		expect(blockColumns(400)).toBe(10);
		expect(10 * step - CELL_GAP).toBeLessThan(300);
		const many = memoryRows(
			{
				"big.md": Array.from(
					{ length: 300 },
					(_, i) =>
						`- Line ${i} [added: 2026-10-${String((i % 20) + 1).padStart(2, "0")}]`,
				).join("\n"),
			},
			today,
		);
		const started = performance.now();
		const [block] = memoryBlocks({ rows: many, today });
		expect(performance.now() - started).toBeLessThan(500);
		expect(block.columns).toBe(10);
		expect(block.height).toBe(30 * step - CELL_GAP);
		const spots = new Set(block.cells.map((cell) => `${cell.x},${cell.y}`));
		expect(spots.size).toBe(300);
	});

	it("gives each project a stable hue and Personal a neutral one", () => {
		expect(blockHue(PERSONAL_SCOPE)).toBe(PERSONAL_HUE);
		expect(blockHue("project:acme-web--7")).toBe(
			blockHue("project:acme-web--7"),
		);
		expect(blockHue("project:acme-web--7")).not.toBe(PERSONAL_HUE);
	});

	it("draws nothing for no memory", () => {
		expect(memoryBlocks({ rows: [], today })).toEqual([]);
	});
});
