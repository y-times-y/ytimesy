import { Pool } from "pg";
import { databaseConfig } from "../config";
import { scopedDatabase } from "./database-scope";

const processDatabase = globalThis as typeof globalThis & {
	ytimesyDatabasePool?: Pool;
};
export function database() {
	const scoped = scopedDatabase();
	if (scoped) return scoped;
	if (!processDatabase.ytimesyDatabasePool) {
		const config = databaseConfig();
		const pool = new Pool({
			connectionString: config.DATABASE_URL,
			max: config.DATABASE_POOL_MAX,
			application_name: "ytimesy",
			connectionTimeoutMillis: 10000,
			idleTimeoutMillis: 30000,
			maxLifetimeSeconds: 300,
			statement_timeout: 20000,
			idle_in_transaction_session_timeout: 30000,
		});
		pool.on("error", () => {
			console.warn(
				"Idle database connection failed; the pool will replace it.",
			);
		});
		processDatabase.ytimesyDatabasePool = pool;
	}
	return processDatabase.ytimesyDatabasePool;
}

export async function closeDatabase() {
	const pool = processDatabase.ytimesyDatabasePool;
	if (!pool) return;
	await pool.end();
	if (processDatabase.ytimesyDatabasePool === pool)
		delete processDatabase.ytimesyDatabasePool;
}
