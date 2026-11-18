/**
 * What this person told the setup card, kept in this browser per account:
 * hidden (they closed it) and sessionsSkipped (they passed on the import).
 */
export type SetupPrefs = {
	readonly hidden: boolean;
	readonly sessionsSkipped: boolean;
};

const EMPTY: SetupPrefs = { hidden: false, sessionsSkipped: false };

export const setupPrefsKey = (userId: string) => `ytimesy.setup.${userId}`;

export function readSetupPrefs(
	storage: Pick<Storage, "getItem">,
	userId: string,
): SetupPrefs {
	try {
		const value: unknown = JSON.parse(
			storage.getItem(setupPrefsKey(userId)) ?? "null",
		);
		if (typeof value !== "object" || value === null) return EMPTY;
		const record = value as Record<string, unknown>;
		return {
			hidden: record.hidden === true,
			sessionsSkipped: record.sessionsSkipped === true,
		};
	} catch {
		return EMPTY;
	}
}

export function writeSetupPrefs(
	storage: Pick<Storage, "setItem">,
	userId: string,
	prefs: SetupPrefs,
) {
	try {
		storage.setItem(setupPrefsKey(userId), JSON.stringify(prefs));
	} catch {
		// A browser that refuses storage just shows the card again.
	}
}
