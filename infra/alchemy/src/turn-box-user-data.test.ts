import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { turnBoxUserData } from "./turn-box-user-data.ts";

const box = join(import.meta.dirname, "..", "..", "turn-box");
const read = (name: string) => readFileSync(join(box, name), "utf8");
const real = {
	bootstrap: read("bootstrap.sh"),
	sigv4: read("sigv4.mjs"),
	start: read("start.mjs"),
	edgeUrl: "https://edge.ytimesy.com",
	logGroup: "/ytimesy/box",
};

test("fills every placeholder of the real bootstrap, under 16 KB, with no credential", () => {
	const script = turnBoxUserData(real);
	assert.doesNotMatch(script, /__[A-Z0-9_]+__/);
	assert.ok(Buffer.byteLength(script) < 16_000);
	assert.ok(script.includes("Environment=YTIMESY_EDGE_URL=https://edge.ytimesy.com"));
	assert.ok(script.includes('"log_group_name":"/ytimesy/box"'));
	assert.ok(script.includes(real.start.replace(/\n$/, "")));
	assert.doesNotMatch(script, /AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY/);
});

test("refuses a bootstrap whose placeholders changed", () => {
	assert.throws(() => turnBoxUserData({ ...real, bootstrap: "#!/bin/bash\n__NEW__\n" }), /no longer has/);
	assert.throws(
		() => turnBoxUserData({ ...real, bootstrap: `${real.bootstrap}\n__EXTRA__\n` }),
		/unfilled placeholder __EXTRA__/,
	);
});
