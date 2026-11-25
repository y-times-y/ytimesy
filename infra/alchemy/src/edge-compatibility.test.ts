import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EDGE_COMPATIBILITY, EVICTION_FLAG } from "./edge-compatibility.ts";

test("idle objects can be evicted instead of billing 15 minutes of pending I/O", () => {
	assert.ok(EDGE_COMPATIBILITY.flags.includes(EVICTION_FLAG));
	assert.ok(EDGE_COMPATIBILITY.flags.includes("nodejs_compat"));
});

test("wrangler.edge-executor.jsonc carries the same flag for every environment", () => {
	const text = readFileSync(
		join(import.meta.dirname, "..", "..", "..", "wrangler.edge-executor.jsonc"),
		"utf8",
	);
	const lines = text.split("\n").filter((l) => l.includes('"compatibility_flags"'));
	assert.ok(lines.length > 0);
	for (const line of lines) assert.ok(line.includes(EVICTION_FLAG));
});
