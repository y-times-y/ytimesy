import { DatabaseSync } from "node:sqlite";

/** In-memory stand-in for a SQLite-backed Durable Object's ctx (storage + alarm). */
export function durableObjectState() {
	const db = new DatabaseSync(":memory:");
	const kv = new Map<string, unknown>();
	const alarm = { at: null as number | null };
	type Storage = {
		sql: {
			exec(
				query: string,
				...bindings: (string | number | null)[]
			): { toArray(): Record<string, unknown>[] };
		};
		get<T>(key: string): Promise<T | undefined>;
		put(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<boolean>;
		transaction<T>(run: (txn: Storage) => Promise<T>): Promise<T>;
		setAlarm(at: number): Promise<void>;
		getAlarm(): Promise<number | null>;
		deleteAlarm(): Promise<void>;
	};
	const storage: Storage = {
		sql: {
			exec(query: string, ...bindings: (string | number | null)[]) {
				const rows = db.prepare(query).all(...bindings);
				return { toArray: () => rows.map((row) => ({ ...row })) };
			},
		},
		async get<T>(key: string) {
			return kv.get(key) as T | undefined;
		},
		async put(key: string, value: unknown) {
			kv.set(key, value);
		},
		async delete(key: string) {
			return kv.delete(key);
		},
		async transaction<T>(run: (txn: Storage) => Promise<T>) {
			return run(storage);
		},
		async setAlarm(at: number) {
			alarm.at = at;
		},
		async getAlarm() {
			return alarm.at;
		},
		async deleteAlarm() {
			alarm.at = null;
		},
	};
	return {
		alarm,
		ctx: {
			storage,
			blockConcurrencyWhile: <T>(run: () => Promise<T>) => run(),
		},
	};
}
