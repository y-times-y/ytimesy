/**
 * Makes the Ed25519 keypair the Workers sign Codex proxy credentials with
 * (docs/research/codex-tunnel-production-2026-11-07.md, "Ed25519 credentials").
 *
 *   node --import tsx scripts/generate-codex-tunnel-keypair.ts --private-key-out <file>
 *
 * Prints only the public key, which goes to /etc/ytimesy-codex-proxy.pub on the
 * proxy instance. The private key goes to <file>, created new with owner-only
 * permissions where the OS supports them; the owner adds it to the production
 * secret bundle as YTIMESY_CODEX_TUNNEL_SIGNING_KEY and then deletes the file.
 * It never reaches the proxy, stdout or a log.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { claudeRunnerKeypair } from "./generate-claude-runner-keypair";

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
		`Private key written to ${resolve(out)}. Add it to the production secret bundle as YTIMESY_CODEX_TUNNEL_SIGNING_KEY, then delete the file.\nPublic key (/etc/ytimesy-codex-proxy.pub on the proxy):\n`,
	);
	process.stdout.write(`${publicKey}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	main(process.argv.slice(2));
