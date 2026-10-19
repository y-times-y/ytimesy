import { expect, it } from "vitest";
import { parseListeningPorts, previewPortAllowed } from "./workspace-preview";

it("lists user-app ports, flags loopback-only ones and hides our own services", () => {
	const output = [
		"LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*",
		"LISTEN 0 511 [::]:3000 [::]:*",
		"LISTEN 0 511 127.0.0.1:5173 0.0.0.0:*",
		"LISTEN 0 511 [::1]:5173 [::]:*",
		"LISTEN 0 100 0.0.0.0:6080 0.0.0.0:*",
		"LISTEN 0 5 127.0.0.1:5900 0.0.0.0:*",
		"LISTEN 0 10 127.0.0.1:9222 0.0.0.0:*",
		"LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
		"LISTEN 0 511 0.0.0.0:41234 0.0.0.0:*",
		"LISTEN 0 511 *:8080 *:*",
		"garbage",
	].join("\n");
	expect(parseListeningPorts(output)).toEqual([
		{ port: 3000, loopbackOnly: false },
		{ port: 5173, loopbackOnly: true },
		{ port: 8080, loopbackOnly: false },
	]);
});

it("allows only ordinary app ports", () => {
	expect(previewPortAllowed(3000)).toBe(true);
	for (const port of [0, 22, 6080, 9222, 32768, 70000, 3000.5])
		expect(previewPortAllowed(port)).toBe(false);
});
