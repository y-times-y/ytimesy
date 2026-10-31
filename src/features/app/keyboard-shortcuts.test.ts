import { expect, it } from "vitest";
import {
	type CommandPaletteItem,
	commandPaletteMatches,
} from "./keyboard-shortcuts";

const run = () => undefined;
const items: CommandPaletteItem[] = [
	{ id: "new", group: "Actions", label: "New chat", run },
	{ id: "c1", group: "Chats", label: "Fix login bug", detail: "acme/web", run },
	{ id: "c2", group: "Chats", label: "Add billing", detail: "acme/api", run },
];

it("finds palette rows holding every word typed, in label or project", () => {
	expect(commandPaletteMatches(items, "").map((item) => item.id)).toEqual([
		"new",
		"c1",
		"c2",
	]);
	expect(commandPaletteMatches(items, "LOGIN").map((item) => item.id)).toEqual([
		"c1",
	]);
	expect(
		commandPaletteMatches(items, "acme api").map((item) => item.id),
	).toEqual(["c2"]);
	expect(commandPaletteMatches(items, "nothing")).toEqual([]);
});
