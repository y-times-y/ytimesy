import { expect, it } from "vitest";
import { readSetupPrefs, setupPrefsKey, writeSetupPrefs } from "./setup-prefs";

function memory() {
	const data = new Map<string, string>();
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
	};
}

it("starts empty and round-trips per account", () => {
	const storage = memory();
	expect(readSetupPrefs(storage, "u1")).toEqual({
		hidden: false,
		sessionsSkipped: false,
	});
	writeSetupPrefs(storage, "u1", { hidden: true, sessionsSkipped: true });
	expect(readSetupPrefs(storage, "u1")).toEqual({
		hidden: true,
		sessionsSkipped: true,
	});
	expect(readSetupPrefs(storage, "u2").hidden).toBe(false);
});

it("ignores a damaged value", () => {
	const storage = memory();
	storage.setItem(setupPrefsKey("u1"), "{not json");
	expect(readSetupPrefs(storage, "u1").hidden).toBe(false);
	storage.setItem(setupPrefsKey("u1"), '"text"');
	expect(readSetupPrefs(storage, "u1").hidden).toBe(false);
});
