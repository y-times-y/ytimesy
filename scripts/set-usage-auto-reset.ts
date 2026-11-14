/**
 * Turns a user's cloud usage auto-reset policy on or off
 * (infrastructure_usage_policy.auto_reset; src/server/adapters/
 * infrastructure-usage.ts). With it on, the account is metered and warned
 * like any other, but a window that would refuse its work restarts instead.
 *
 *   node --env-file-if-exists=.env --import tsx scripts/set-usage-auto-reset.ts --email <e> --on|--off [--apply] [--confirm-production]
 *
 * Without --apply it only shows what it would change. Target: DATABASE_URL.
 * Any database other than the development project counts as production and
 * needs --confirm-production. Prints only the user id's prefix and the flag.
 */
import { parseArgs } from "node:util";
import pg from "pg";
import { supabaseCertificate } from "./supabase-certificate";

const DEVELOPMENT_REF = "exampledevprojectref";

const { values } = parseArgs({
	options: {
		email: { type: "string" },
		on: { type: "boolean", default: false },
		off: { type: "boolean", default: false },
		apply: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
		"confirm-production": { type: "boolean", default: false },
	},
});
const email = values.email?.trim().toLowerCase();
if (!email || values.on === values.off)
	throw new Error("Usage: --email <address> and exactly one of --on or --off.");
const enable = values.on;
const apply = values.apply && !values["dry-run"];

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL.");
const production = !new URL(url).username.includes(DEVELOPMENT_REF);
if (production && !values["confirm-production"])
	throw new Error(
		"DATABASE_URL is not the development project; pass --confirm-production to change production.",
	);

const client = new pg.Client({
	connectionString: url
		.replace(/[?&]sslrootcert=[^&]*/, "")
		.replace(/[?&]sslmode=[^&]*/, ""),
	ssl: { ca: supabaseCertificate(), rejectUnauthorized: true },
});
await client.connect();
try {
	const user = (
		await client.query<{ id: string; auto_reset: boolean | null }>(
			`select u.id,p.auto_reset from auth_user u
			 left join infrastructure_usage_policy p on p.user_id=u.id
			 where lower(u.email)=$1`,
			[email],
		)
	).rows;
	if (user.length !== 1)
		throw new Error(`Expected one user with that email, found ${user.length}.`);
	const { id, auto_reset } = user[0];
	const target = production ? "production" : "development";
	const prefix = `${id.slice(0, 8)}…`;
	if (!apply) {
		console.log(
			`[dry run, ${target}] user ${prefix}: auto_reset ${auto_reset === true} -> ${enable}. Re-run with --apply to change it.`,
		);
	} else {
		// A policy row keeps any limit overrides; a new one only sets the flag.
		const saved = await client.query<{ auto_reset: boolean }>(
			`insert into infrastructure_usage_policy(user_id,auto_reset) values($1,$2)
			 on conflict(user_id) do update set auto_reset=excluded.auto_reset
			 returning auto_reset`,
			[id, enable],
		);
		console.log(
			`[${target}] user ${prefix}: auto_reset ${saved.rows[0].auto_reset}`,
		);
	}
} finally {
	await client.end();
}
