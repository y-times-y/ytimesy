/**
 * The edge's Ed25519 keys for turn runner boxes and a box's identity token
 * (docs/turn-runner-boxes.md, "Credentials").
 *
 *   node --import tsx scripts/turn-box-keys.ts keypair --private-key-out <file>
 *     Writes the private key (TURN_BOX_EDGE_PRIVATE_KEY) to <file>, owner-only,
 *     never overwriting; prints only the public key (TURN_BOX_EDGE_PUBLIC_KEY).
 *   node --import tsx scripts/turn-box-keys.ts identity --private-key-file <file> --box-id <id> [--hours 24]
 *     Writes the box's identity token to --out <file> (owner-only), never stdout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	generateTurnBoxKeyPair,
	issueTurnBoxIdentity,
} from "../src/domain/turn-box-grant";

function flag(argv: readonly string[], name: string) {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv: readonly string[]) {
	const [command] = argv;
	if (command === "keypair") {
		const out = flag(argv, "--private-key-out");
		if (!out) throw new Error("Pass --private-key-out <file>.");
		const { privateKey, publicKey } = await generateTurnBoxKeyPair();
		writeFileSync(resolve(out), `${privateKey}\n`, { flag: "wx", mode: 0o600 });
		process.stdout.write(`${publicKey}\n`);
		return;
	}
	if (command === "identity") {
		const keyFile = flag(argv, "--private-key-file");
		const boxId = flag(argv, "--box-id");
		const out = flag(argv, "--out");
		if (!keyFile || !boxId || !out)
			throw new Error("Pass --private-key-file, --box-id and --out.");
		const hours = Number(flag(argv, "--hours") ?? 24);
		const token = await issueTurnBoxIdentity(
			readFileSync(resolve(keyFile), "utf8").trim(),
			{ boxId, expiresAt: Date.now() + hours * 3_600_000 },
		);
		writeFileSync(resolve(out), `${token}\n`, { flag: "wx", mode: 0o600 });
		return;
	}
	throw new Error("Usage: turn-box-keys.ts keypair|identity ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main(process.argv.slice(2));
