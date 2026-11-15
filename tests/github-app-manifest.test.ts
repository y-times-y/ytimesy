import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const manifest = readFileSync("scripts/setup-github-app.mjs", "utf8");
const permissions = manifest.match(/default_permissions:\s*\{([^}]*)\}/)?.[1];

it("grants the App every permission the server requests from it", () => {
	expect(permissions).toBeDefined();
	expect(permissions).toContain("checks: 'read'");
	expect(permissions).toContain("contents: 'write'");
	expect(permissions).toContain("pull_requests: 'write'");
	expect(permissions).toContain("metadata: 'read'");
	// Wake-ups retain least-privilege read tokens; the app also lets users edit issues and re-run CI.
	const wake = readFileSync(
		"src/server/adapters/github/pull-request-wake-github.ts",
		"utf8",
	);
	// Wake-ups read check runs on installation tokens.
	expect(wake).toContain('checks: "read"');
	expect(wake).toContain('actions: "read"');
	expect(permissions).toContain("issues: 'write'");
	expect(permissions).toContain("actions: 'write'");
});
