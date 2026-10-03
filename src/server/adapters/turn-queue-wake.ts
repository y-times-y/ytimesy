import { Client } from "pg";
import { serverConfig } from "../config";

/** One session connection per worker, never per user or stream. Polling backstops lost notifications. */
export function listenForQueuedTurns(wake: () => void) {
	let stopped = false;
	let current: Client | null = null;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const connect = async () => {
		if (stopped) return;
		const client = new Client({
			connectionString: serverConfig().DATABASE_URL,
			application_name: "ytimesy-turn-wake",
			connectionTimeoutMillis: 5000,
		});
		current = client;
		let failed = false;
		const reconnect = () => {
			if (failed) return;
			failed = true;
			void client.end().catch(() => {});
			if (!stopped) {
				retry = setTimeout(() => void connect(), 5000);
				retry.unref();
			}
		};
		client.on("error", reconnect);
		client.on("end", reconnect);
		client.on("notification", (event) => {
			if (event.channel === "ytimesy_turn_queued" && !stopped) wake();
		});
		try {
			await client.connect();
			if (stopped) {
				await client.end();
				return;
			}
			await client.query("LISTEN ytimesy_turn_queued");
			wake();
		} catch {
			reconnect();
		}
	};
	void connect();
	return async () => {
		stopped = true;
		clearTimeout(retry);
		await current?.end().catch(() => {});
	};
}
