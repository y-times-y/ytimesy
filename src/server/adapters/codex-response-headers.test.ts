import { beforeEach, expect, it, vi } from "vitest";
import {
	forgetCodexResponseHeaderLogForTests,
	logCodexResponseHeaderNames,
} from "./codex-subscription-transport";

beforeEach(() => {
	vi.restoreAllMocks();
	forgetCodexResponseHeaderLogForTests();
});

it("logs only header names, at most once an hour", () => {
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	const headers = new Headers({
		"X-Models-Etag": "secret-value",
		"Content-Type": "text/event-stream",
	});
	logCodexResponseHeaderNames(headers, 1_000);
	logCodexResponseHeaderNames(headers, 1_000 + 3_599_000);
	expect(info).toHaveBeenCalledTimes(1);
	expect(info).toHaveBeenCalledWith("codex.response_headers", {
		names: ["content-type", "x-models-etag"],
	});
	expect(JSON.stringify(info.mock.calls)).not.toContain("secret-value");
	logCodexResponseHeaderNames(headers, 1_000 + 3_600_000);
	expect(info).toHaveBeenCalledTimes(2);
});
