import { expect, it } from "vitest";
import {
	AGENT_SECRETS_DIRECTORY,
	AGENT_SECRETS_ENV_PATH,
	LEGACY_AGENT_SECRETS_DIRECTORY,
	SCRUB_AGENT_SECRETS,
} from "./project-secret";

/**
 * The workspace image's tmpfiles.d (Ubuntu 24.04,
 * /usr/lib/tmpfiles.d/tmp.conf): `D /tmp 1777 root root 30d` empties /tmp on
 * every boot; its /var/tmp line ships commented out.
 */
const BOOT_EMPTIED = ["/tmp/"];

it("keeps a chat's secrets where a stopped and restarted VM still has them", () => {
	for (const prefix of BOOT_EMPTIED) {
		expect(AGENT_SECRETS_DIRECTORY.startsWith(prefix)).toBe(false);
		expect(AGENT_SECRETS_ENV_PATH.startsWith(prefix)).toBe(false);
	}
	expect(AGENT_SECRETS_ENV_PATH).toBe(`${AGENT_SECRETS_DIRECTORY}/agent.env`);
});

it("scrubs the secrets of a VM prepared before the move as well", () => {
	expect(SCRUB_AGENT_SECRETS).toContain(`rm -rf ${AGENT_SECRETS_DIRECTORY}`);
	expect(SCRUB_AGENT_SECRETS).toContain(LEGACY_AGENT_SECRETS_DIRECTORY);
	expect(SCRUB_AGENT_SECRETS).toContain(
		`test ! -e ${LEGACY_AGENT_SECRETS_DIRECTORY}`,
	);
});
