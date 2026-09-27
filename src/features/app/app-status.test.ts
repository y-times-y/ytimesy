import { expect, it } from "vitest";
import { appErrorDetail } from "./app-status";

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
