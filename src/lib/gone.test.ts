import { expect, it } from "vitest";
import { goneResponse } from "./gone";

it("answers 410 with noindex so search engines drop a removed page", async () => {
	const response = goneResponse();
	expect(response.status).toBe(410);
	expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
	expect(await response.text()).toContain("removed");
});
