/**
 * Makes the Ed25519 keypair the edge signs runner-box requests with
 * (docs/claude-code-placement.md, "Runner box signatures").
 *
 *   node --import tsx scripts/generate-claude-runner-keypair.ts --private-key-out <file>
 *
 * Prints only the public key (RUNNER_PUBLIC_KEY on the boxes, and
 * provision.py --public-key). The private key goes to <file>, created new
 * with owner-only permissions where the OS supports them; the owner adds it to
 * the production secret bundle as YTIMESY_CLAUDE_RUNNER_SIGNING_KEY and then
 * deletes the file. It never reaches a box, stdout or a log.
 */
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Both halves as the settings take them: base64 PKCS8 DER and base64 SPKI DER. */
export function claudeRunnerKeypair() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		signingKey: privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64"),
		publicKey: publicKey
			.export({ format: "der", type: "spki" })
			.toString("base64"),
	};
}

function main(argv: readonly string[]) {
	const at = argv.indexOf("--private-key-out");
	const out = at >= 0 ? argv[at + 1] : undefined;
	if (!out)
		throw new Error(
			"Pass --private-key-out <file>: the private key is never printed.",
		);
	const { signingKey, publicKey } = claudeRunnerKeypair();
	// "wx": never overwrite an existing key file.
	writeFileSync(resolve(out), `${signingKey}\n`, { flag: "wx", mode: 0o600 });
	process.stderr.write(
		`Private key written to ${resolve(out)}. Add it to the production secret bundle as YTIMESY_CLAUDE_RUNNER_SIGNING_KEY, then delete the file.\nPublic key (RUNNER_PUBLIC_KEY on each box):\n`,
	);
	process.stdout.write(`${publicKey}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main(process.argv.slice(2));
