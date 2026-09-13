import { Pool } from "pg";
import { serverConfig } from "../config";

let pool: Pool | undefined;
export function database() {
	if (!pool)
		pool = new Pool({
			connectionString: serverConfig().DATABASE_URL,
			max: 5,
			connectionTimeoutMillis: 10000,
			idleTimeoutMillis: 30000,
			statement_timeout: 20000,
			idle_in_transaction_session_timeout: 30000,
		});
	return pool;
}
