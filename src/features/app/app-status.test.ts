import { expect, it } from "vitest";
import { appErrorDetail, reloadWhenSignedOut } from "./app-status";

it("uses a short product message when one exists", () => {
	expect(appErrorDetail(new Error("Database is down"))).toBe(
		"Database is down",
	);
});

it("hides compiler dumps and empty errors", () => {
	expect(
		appErrorDetail(
			new Error(
				"Transform failed with 1 error:\n[PARSE_ERROR] Expected '}' but found ':'\nsrc/server/adapters/freestyle/start-desktop.ts:69:139",
			),
		),
	).toBe("Try again, or go home.");
	expect(appErrorDetail({})).toBe("Try again, or go home.");
});

it("hides JavaScript faults such as reading a property of undefined", () => {
	expect(
		appErrorDetail(
			new TypeError("Cannot read properties of undefined (reading 'filter')"),
		),
	).toBe("Try again, or go home.");
});

it("reloads once when the session is gone, never when signed in or offline", async () => {
	const store = new Map<string, string>();
	let reloads = 0;
	let now = 1_000_000;
	const page = {
		reload: () => {
			reloads++;
		},
		storage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => {
				store.set(k, v);
			},
		},
		now: () => now,
	};
	const answer = (body: unknown) => async () => Response.json(body);
	expect(await reloadWhenSignedOut(answer({ user: { id: "u" } }), page)).toBe(
		false,
	);
	expect(
		await reloadWhenSignedOut(async () => {
			throw new Error("offline");
		}, page),
	).toBe(false);
	expect(await reloadWhenSignedOut(answer(null), page)).toBe(true);
	// Not again within a minute: no reload loop.
	now += 30_000;
	expect(await reloadWhenSignedOut(answer(null), page)).toBe(false);
	now += 60_000;
	expect(await reloadWhenSignedOut(answer(null), page)).toBe(true);
	expect(reloads).toBe(2);
});
