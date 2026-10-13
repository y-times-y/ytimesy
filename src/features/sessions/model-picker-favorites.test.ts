import { afterEach, expect, it, vi } from "vitest";
import {
	favoriteModelKey,
	readModelFavorites,
	writeModelFavorites,
} from "./model-picker-favorites";

afterEach(() => vi.unstubAllGlobals());

it("namespaces favorites by provider", () => {
	expect(favoriteModelKey("codex", "same")).not.toBe(
		favoriteModelKey("api", "same"),
	);
});

it("round trips favorites and ignores invalid stored values", () => {
	let stored = "";
	vi.stubGlobal("window", {
		localStorage: {
			getItem: () => stored,
			setItem: (_key: string, value: string) => {
				stored = value;
			},
		},
	});
	writeModelFavorites([favoriteModelKey("codex", "model")]);
	expect(readModelFavorites()).toEqual([favoriteModelKey("codex", "model")]);
	stored = '[1, null, "valid"]';
	expect(readModelFavorites()).toEqual(["valid"]);
	stored = "broken";
	expect(readModelFavorites()).toEqual([]);
	stored = "{}";
	expect(readModelFavorites()).toEqual([]);
});

it("tolerates blocked browser storage", () => {
	vi.stubGlobal("window", {
		get localStorage() {
			throw new Error("Blocked");
		},
	});
	expect(readModelFavorites()).toEqual([]);
	expect(() => writeModelFavorites(["model"])).not.toThrow();
});
