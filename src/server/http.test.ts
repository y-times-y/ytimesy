import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireSameOrigin } from "./http";

const APP = "http://127.0.0.1:3000";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.fn\.ts$/.test(name) ? [path] : [];
	});
}

describe("requireSameOrigin", () => {
	it("refuses a same-origin POST without a JSON body", () => {
		const request = new Request(`${APP}/_serverFn/x`, {
			method: "POST",
			headers: { origin: APP },
		});
		expect(() => requireSameOrigin(request)).toThrow();
	});

	// A server function called with no data sends no body and no content
	// type, so requireSameOrigin answers 415 and the call can never succeed.
	it("is only used by POST server functions that take input", () => {
		const offenders = sourceFiles("src").flatMap((file) => {
			const source = readFileSync(file, "utf8");
			return [
				...source.matchAll(
					/export const (\w+) = createServerFn\(\{ method: "POST" \}\)\.handler\(([\s\S]*?)\n\);/g,
				),
			]
				.filter((match) => match[2].includes("requireSameOrigin("))
				.map((match) => `${file}: ${match[1]}`);
		});
		expect(offenders).toEqual([]);
	});
});
