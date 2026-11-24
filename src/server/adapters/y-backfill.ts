/**
 * Turns Y² on for the projects that never chose (docs/y.md, "On by default").
 *
 * Safe by construction: it only flips a live project from off to on when
 * nothing says the person chose off, in batches of a few hundred rows (each
 * batch its own statement, rows locked with skip locked, so it never holds a
 * lock on a big table or waits on a busy row), and a second run finds
 * nothing. Before 20261124150000 the data could not tell "never set" from
 * "turned off", so older rows are judged by what they left behind:
 *
 * - a Y² chat of the project exists (even archived): Y² was on and the person
 *   turned it off;
 * - the project was created after new projects started with Y² on
 *   (15532cb9): it began on, so off is a choice.
 *
 * Those are kept off and recorded as an explicit "off". An archived project
 * is left alone; so is the project of a user who turned Y² off for all.
 */
export const Y_DEFAULT_ON_SINCE = "2026-11-23 07:48:26+00";

type Queryable = {
	query: (
		sql: string,
		values?: unknown[],
	) => Promise<{ rows: Record<string, unknown>[] }>;
};

const NEVER_SET =
	"not p.y_enabled and p.y_choice is null and p.archived_at is null";
const CHOSE_OFF = `(exists(select 1 from agent_session s where s.project_id=p.id and s.chat_role='y2')
	or p.created_at >= timestamptz '${Y_DEFAULT_ON_SINCE}')`;
const USER_TURNED_OFF =
	"exists(select 1 from user_y_setting u where u.user_id=p.user_id and not u.enabled)";

export type YBackfillReport = {
	readonly applied: boolean;
	readonly enabledProjects: number;
	readonly enabledUsers: number;
	readonly keptOff: number;
};

export async function ySquaredBackfill(
	db: Queryable,
	options: { readonly apply: boolean; readonly batchSize?: number },
): Promise<YBackfillReport> {
	const batch = options.batchSize ?? 500;
	const markOff = `${NEVER_SET} and ${CHOSE_OFF}`;
	const enable = `${NEVER_SET} and not ${CHOSE_OFF} and not ${USER_TURNED_OFF}`;
	if (!options.apply) {
		const row = (
			await db.query(
				`select
				  (select count(*) from project p where ${markOff}) as kept_off,
				  (select count(*) from project p where ${enable}) as enabled,
				  (select count(distinct p.user_id) from project p where ${enable}) as users`,
			)
		).rows[0];
		return {
			applied: false,
			enabledProjects: Number(row?.enabled ?? 0),
			enabledUsers: Number(row?.users ?? 0),
			keptOff: Number(row?.kept_off ?? 0),
		};
	}
	const drain = async (predicate: string, set: string) => {
		const users = new Set<string>();
		let rows = 0;
		for (;;) {
			const { rows: changed } = await db.query(
				`update project set ${set} where id in (
				   select p.id from project p where ${predicate}
				   order by p.id limit $1 for update skip locked)
				 returning user_id`,
				[batch],
			);
			for (const row of changed) users.add(String(row.user_id));
			rows += changed.length;
			if (changed.length < batch) return { rows, users };
		}
	};
	// Record the choices first, so the enabling pass can never see them.
	const off = await drain(markOff, "y_choice='off'");
	const on = await drain(enable, "y_enabled=true");
	return {
		applied: true,
		enabledProjects: on.rows,
		enabledUsers: on.users.size,
		keptOff: off.rows,
	};
}
