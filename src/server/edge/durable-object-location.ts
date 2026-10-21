/** Cloudflare's Durable Object location hints. */
const LOCATION_HINTS = [
	"wnam",
	"enam",
	"sam",
	"weur",
	"eeur",
	"apac",
	"apac-ne",
	"apac-se",
	"oc",
	"afr",
	"me",
] as const;
type LocationHint = (typeof LOCATION_HINTS)[number];

let warned = false;

/**
 * Where a new chat, environment or job object should live: near the database
 * its steps query dozens of times, not near whichever colo sent the first
 * request. Set per deployment in YTIMESY_DURABLE_OBJECT_LOCATION_HINT
 * (development's database is in us-west-2, production's in us-east-2).
 * Cloudflare honours a hint only when an object is first created, so passing
 * it on every lookup is harmless and existing objects stay where they are.
 */
export function durableObjectLocation(
	env: Record<string, string | undefined> = process.env,
): { locationHint: LocationHint } | undefined {
	const hint = env.YTIMESY_DURABLE_OBJECT_LOCATION_HINT?.trim();
	if (!hint) return undefined;
	if ((LOCATION_HINTS as readonly string[]).includes(hint))
		return { locationHint: hint as LocationHint };
	if (!warned) {
		warned = true;
		console.warn("Unknown Durable Object location hint; using the default.");
	}
	return undefined;
}
