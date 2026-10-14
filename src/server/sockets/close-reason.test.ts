import { expect, it } from "vitest";
import { MAX_CLOSE_REASON_BYTES, webSocketCloseReason } from "./close-reason";

const bytes = (value: string) => new TextEncoder().encode(value).length;

it("keeps short reasons and truncates long ones within the UTF-8 byte limit", () => {
	expect(webSocketCloseReason("Desktop is not ready.")).toBe(
		"Desktop is not ready.",
	);
	expect(webSocketCloseReason(undefined)).toBeUndefined();
	const ascii = webSocketCloseReason("x".repeat(500));
	expect(bytes(ascii ?? "")).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
	expect(ascii?.endsWith("…")).toBe(true);
	// 60 three-byte characters exceed the limit despite being under 123 code units.
	const wide = webSocketCloseReason("界".repeat(60));
	expect(bytes(wide ?? "")).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
	expect(wide).toMatch(/^界+…$/);
	const emoji = webSocketCloseReason("😀".repeat(40));
	expect(bytes(emoji ?? "")).toBeLessThanOrEqual(MAX_CLOSE_REASON_BYTES);
	expect(emoji).toMatch(/^(😀)+…$/u);
});
