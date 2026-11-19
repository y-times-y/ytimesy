import { expect, it } from "vitest";
import {
	readComposerChoice,
	writeComposerChoice,
} from "./last-composer-choice";

function memory() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
	};
}

it("remembers the harness and model the person chose", () => {
	const storage = memory();
	writeComposerChoice({ harnessId: "api", modelId: "route-1" }, storage);
	expect(readComposerChoice(storage)).toEqual({
		harnessId: "api",
		modelId: "route-1",
	});
});

it("ignores nothing, junk and unknown harnesses", () => {
	const storage = memory();
	expect(readComposerChoice(storage)).toBeNull();
	storage.setItem("ytimesy-composer-choice", "not json");
	expect(readComposerChoice(storage)).toBeNull();
	storage.setItem(
		"ytimesy-composer-choice",
		JSON.stringify({ harnessId: "other", modelId: "x" }),
	);
	expect(readComposerChoice(storage)).toBeNull();
});
