export type CrewScope = {
	projectId: string | null;
	yEnabled: boolean;
	ySquaredId: string | null;
};

type Sql = Pick<SqlStorage, "exec">;

/**
 * A chat's project and Y switch, kept in SQLite only when they change. A chat
 * object only learns them from a caller that resolved them in Postgres
 * (resolveModelConversation); turns are started by callers that cannot, so
 * the object resolves them itself when a turn starts (ModelConversation.startTurn).
 */
export class SqliteCrewScope {
	private cache: CrewScope | null | undefined;
	constructor(private readonly sql: Sql) {}
	read(): CrewScope | null {
		if (this.cache !== undefined) return this.cache;
		this.sql.exec(
			"create table if not exists crew_scope(id integer primary key check(id=1),project_id text,y_enabled integer not null,y2_id text)",
		);
		const row = this.sql
			.exec<{
				project_id: string | null;
				y_enabled: number;
				y2_id: string | null;
			}>("select project_id,y_enabled,y2_id from crew_scope")
			.toArray()[0];
		this.cache = row
			? {
					projectId: row.project_id,
					yEnabled: row.y_enabled === 1,
					ySquaredId: row.y2_id,
				}
			: null;
		return this.cache;
	}
	remember(scope: {
		projectId?: string | null;
		yEnabled?: boolean | null;
		ySquaredId?: string | null;
	}) {
		const next: CrewScope = {
			projectId: scope.projectId ?? null,
			yEnabled: !!scope.yEnabled,
			ySquaredId: scope.ySquaredId ?? null,
		};
		const known = this.read();
		if (
			known?.projectId === next.projectId &&
			known.yEnabled === next.yEnabled &&
			known.ySquaredId === next.ySquaredId
		)
			return;
		if (!known && !next.yEnabled && !next.projectId) return;
		this.sql.exec(
			"insert into crew_scope(id,project_id,y_enabled,y2_id) values(1,?,?,?) on conflict(id) do update set project_id=excluded.project_id,y_enabled=excluded.y_enabled,y2_id=excluded.y2_id",
			next.projectId,
			next.yEnabled ? 1 : 0,
			next.ySquaredId,
		);
		this.cache = next;
	}
}
