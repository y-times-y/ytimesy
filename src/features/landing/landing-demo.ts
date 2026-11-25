import { HELPER_COLORS, KIND_ICONS } from "#/domain/helper-names";

/** The fleet tile's example agents. Plain data; nothing runs. */

export const DEMO_AGENTS = [
	{
		name: "build-1",
		icon: KIND_ICONS.writer,
		color: HELPER_COLORS[2],
		task: "Theme tokens and the toggle",
		done: true,
	},
	{
		name: "build-2",
		icon: KIND_ICONS.writer,
		color: HELPER_COLORS[0],
		task: "Settings page",
		done: true,
	},
	{
		name: "verify-1",
		icon: KIND_ICONS.checker,
		color: HELPER_COLORS[4],
		task: "Check it in the browser",
		done: false,
	},
] as const;

export type DemoAgent = (typeof DEMO_AGENTS)[number];
