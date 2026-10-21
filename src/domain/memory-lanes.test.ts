import { describe, expect, it } from "vitest";
import {
	axisStep,
	dayNumber,
	laneColor,
	memoryLanes,
	PERSONAL_COLOR,
} from "./memory-lanes";
import { memoryRows, PERSONAL_SCOPE } from "./memory-overview";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const files = {
	"MEMORY.md": "# Memory\n\n## Index\n- [[api]]\n",
	"api.md": `# API\n\n- New webhook events go to v1 [superseded-by: /?chat=${B}; source: /?chat=${A}; added: 2026-10-01]\n- Errors are problem+json [project: acme/web; source: /?chat=${A}; added: 2026-10-16]\n- New webhook events go to v2 only [project: acme/web; source: /?chat=${B}; added: 2026-10-18]\n- Uses pnpm [scope: always; added: 2026-10-18]\n- Prefers early returns [kind: inferred; added: 2026-10-18]\n- Undated note\n`,
	"billing.md":
		"# Billing\n\n- Cents, never floats [project: acme/billing; added: 2026-10-05]\n",
};
const today = "2026-10-21";
const rows = memoryRows(files, today);
const dreams = [
	{
		at: "2026-10-19T03:00:00Z",
		message: "Merged the error notes",
		merges: [
			{
				into: "Errors are problem+json",
				from: [
					{ text: "Errors are JSON", added: "2026-10-03", project: "acme/web" },
					{
						text: "API errors use problem+json",
						added: "2026-10-07",
						project: "acme/web",
						kind: "inferred" as const,
					},
				],
			},
		],
	},
];

describe("memory lanes", () => {
	const lanes = memoryLanes({ rows, today, scope: null, dreams });
	const node = (text: string) => {
		const found = lanes.nodes.find((entry) => entry.row.text.startsWith(text));
		if (!found) throw new Error(`no node ${text}`);
		return found;
	};

	it("puts Personal first, then each project by name, one lane each", () => {
		expect(lanes.lanes.map((lane) => [lane.id, lane.count])).toEqual([
			[PERSONAL_SCOPE, 3],
			["project:acme/billing", 1],
			["project:acme/web", 2],
		]);
		expect(
			memoryLanes({ rows, today, scope: "project:acme/web" }).lanes.map(
				(lane) => lane.id,
			),
		).toEqual(["project:acme/web"]);
	});

	it("places each line on its lane at its added date, stacking same-day lines", () => {
		expect(node("Errors are").day).toBe(dayNumber("2026-10-16"));
		expect(node("Errors are").lane).toBe(2);
		const sameDay = ["Uses pnpm", "Prefers early"].map(
			(text) => node(text).slot,
		);
		expect(sameDay.sort()).toEqual([-1, 0]);
		expect(lanes.lanes[0].depth).toBe(2);
		expect(node("Undated")).toMatchObject({ undated: true, day: lanes.start });
		expect(lanes.start).toBeLessThan(dayNumber("2026-10-01") ?? 0);
		expect(lanes.end).toBeGreaterThan(lanes.today);
	});

	it("marks stated, inferred, rules, new and retired lines", () => {
		expect(node("Uses pnpm")).toMatchObject({ mark: "rule", recent: true });
		expect(node("Prefers early")).toMatchObject({ mark: "inferred" });
		expect(node("Cents")).toMatchObject({ mark: "stated", recent: false });
		expect(node("New webhook events go to v1")).toMatchObject({
			retired: true,
		});
	});

	it("curves an older line to the line that replaced it, across lanes", () => {
		expect(lanes.curves.map((curve) => [curve.from, curve.to])).toEqual([
			["api.md:3", "api.md:5"],
		]);
		const older = node("New webhook events go to v1");
		const newer = node("New webhook events go to v2");
		expect(older.lane).not.toBe(newer.lane);
		expect([older.version, newer.version, newer.versions]).toEqual([1, 2, 2]);
		expect(older.chain).toEqual(["api.md:3", "api.md:5"]);
	});

	it("draws each dream at its date with merged lines converging on the result", () => {
		expect(lanes.dreams).toHaveLength(1);
		const [dream] = lanes.dreams;
		expect(dream.day).toBe(dayNumber("2026-10-19"));
		expect(dream.merges).toEqual([
			{
				lane: 2,
				into: "api.md:4",
				text: "Errors are problem+json",
				ghosts: [
					{
						text: "Errors are JSON",
						lane: 2,
						day: dayNumber("2026-10-03"),
						mark: "stated",
					},
					{
						text: "API errors use problem+json",
						lane: 2,
						day: dayNumber("2026-10-07"),
						mark: "inferred",
					},
				],
			},
		]);
	});

	it("colours projects like the sidebar dots and keeps Personal neutral", () => {
		expect(laneColor(null)).toBe(PERSONAL_COLOR);
		expect(laneColor("p1")).toBe(laneColor("p1"));
		expect(axisStep(40)).toBe(2);
		expect(axisStep(2)).toBe(61);
	});
});
