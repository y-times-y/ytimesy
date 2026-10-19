import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const manifest = readFileSync("scripts/setup-github-app.mjs", "utf8");
const permissions = manifest.match(/default_permissions:\s*\{([^}]*)\}/)?.[1];

it("grants the App every permission the server requests from it", () => {
	expect(permissions).toBeDefined();
	// PR repair asks for checks: read on installation tokens (pr-repair-evidence.ts).
	const evidence = readFileSync(
		"src/server/adapters/github/pr-repair-evidence.ts",
		"utf8",
	);
	expect(evidence).toContain('checks: "read"');
	expect(permissions).toContain("checks: 'read'");
	expect(permissions).toContain("contents: 'write'");
	expect(permissions).toContain("pull_requests: 'write'");
	expect(permissions).toContain("metadata: 'read'");
	// GitHub delivers issue_comment only with Issues read; wake-ups read job logs with Actions read.
	const wake = readFileSync(
		"src/server/adapters/github/pull-request-wake-github.ts",
		"utf8",
	);
	expect(wake).toContain('actions: "read"');
	expect(permissions).toContain("issues: 'read'");
	expect(permissions).toContain("actions: 'read'");
});
