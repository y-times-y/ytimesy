/**
 * Development-only harness variants, selected per eval user (dev_eval_user)
 * so concurrent eval runs can compare harness behaviour on one deployment.
 * Production never reads them. See docs/parallel-evals.md.
 */
export const HARNESS_VARIANT_VALUES = {
	/**
	 * How recalled memory (MEMORY.md and read-hook lines) is presented:
	 * notes = neutral data that may be outdated (the product default);
	 * rules = binding project rules from earlier chats.
	 */
	memoryWording: ["notes", "rules"],
	/**
	 * The builder's tool surface. Only "current" is implemented; the lean
	 * surfaces are reserved (src/server/services/harness-tool-surfaces.ts).
	 */
	toolSurface: ["current", "lean-native", "lean-pi"],
} as const;

type Values = typeof HARNESS_VARIANT_VALUES;
export type HarnessVariant = {
	readonly [Key in keyof Values]: Values[Key][number];
};
export type MemoryWording = HarnessVariant["memoryWording"];
export type HarnessToolSurfaceId = HarnessVariant["toolSurface"];

export const DEFAULT_HARNESS_VARIANT: HarnessVariant = {
	memoryWording: "notes",
	toolSurface: "current",
};

function isKey(key: string): key is keyof Values {
	return Object.hasOwn(HARNESS_VARIANT_VALUES, key);
}

function validValue(key: keyof Values, value: unknown) {
	return (HARNESS_VARIANT_VALUES[key] as readonly unknown[]).includes(value);
}

/**
 * A stored variant: unknown keys and values fall back to the default, so a
 * row written by a newer script never breaks a turn.
 */
export function harnessVariantFromUnknown(value: unknown): HarnessVariant {
	const variant: Record<string, unknown> = { ...DEFAULT_HARNESS_VARIANT };
	if (value && typeof value === "object" && !Array.isArray(value))
		for (const [key, entry] of Object.entries(value))
			if (isKey(key) && validValue(key, entry)) variant[key] = entry;
	return variant as HarnessVariant;
}

/** `key=value` flags (e.g. `memoryWording=rules`); unknown keys or values throw. */
export function harnessVariantFromFlags(
	flags: readonly string[] = [],
): HarnessVariant {
	const variant: Record<string, unknown> = { ...DEFAULT_HARNESS_VARIANT };
	for (const flag of flags)
		for (const pair of flag.split(",")) {
			const [key, value, ...rest] = pair.split("=").map((part) => part.trim());
			if (!key || value === undefined || rest.length || !isKey(key))
				throw new Error(
					`--variant expects key=value with key in ${Object.keys(HARNESS_VARIANT_VALUES).join(", ")}; got "${pair}".`,
				);
			if (!validValue(key, value))
				throw new Error(
					`--variant ${key} accepts ${HARNESS_VARIANT_VALUES[key].join(", ")}; got "${value}".`,
				);
			variant[key] = value;
		}
	return variant as HarnessVariant;
}

/** Only the keys that differ from the default, for labels and stored rows. */
export function harnessVariantChanges(
	variant: HarnessVariant,
): Partial<HarnessVariant> {
	return Object.fromEntries(
		Object.entries(variant).filter(
			([key, value]) =>
				DEFAULT_HARNESS_VARIANT[key as keyof HarnessVariant] !== value,
		),
	) as Partial<HarnessVariant>;
}

export function harnessVariantLabel(variant: HarnessVariant) {
	const changes = Object.entries(harnessVariantChanges(variant));
	return changes.length
		? changes.map(([key, value]) => `${key}=${value}`).join(",")
		: "default";
}
