import { expect, it } from "vitest";
import { editDiagnostics } from "./edit-diagnostics";

it("reports syntax errors without executing repository code or claiming type checking", () => {
	expect(editDiagnostics("src/invalid.ts", "export const = ;")).toMatchObject({
		syntaxChecked: true,
		diagnostics: expect.arrayContaining([expect.any(String)]),
	});
	expect(
		editDiagnostics(
			"src/valid.ts",
			"export const value: number = 'type error';",
		),
	).toEqual({ syntaxChecked: true, diagnostics: [] });
	expect(
		editDiagnostics("src/valid.tsx", "export const A = () => <div />;"),
	).toEqual({ syntaxChecked: true, diagnostics: [] });
	expect(editDiagnostics("data.txt", "anything")).toEqual({
		syntaxChecked: false,
		diagnostics: [],
	});
	expect(editDiagnostics("large.ts", undefined).syntaxChecked).toBe(false);
});
