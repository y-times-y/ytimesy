import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	scopedDatabase,
	withDatabaseScope,
} from "#/server/adapters/database-scope";
import { lockedVm } from "#/server/adapters/freestyle/usage-admission";

/** Uses disposable advisory locks only; no application records, VMs, or inference. */
async function proveAdmissionConcurrency() {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required.");
	await withDatabaseScope(connectionString, async () => {
		const slug = `admission-concurrency-proof-${randomUUID()}`;
		let markEntered!: () => void;
		let releaseFirst!: () => void;
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const events: string[] = [];
		const first = lockedVm(slug, async () => {
			events.push("first-enter");
			markEntered();
			await firstGate;
			events.push("first-exit");
		});
		await Promise.race([entered, first]);
		const second = lockedVm(slug, async () => {
			events.push("second-enter");
		});
		const secondResult = second.then(
			() => null,
			(error: Error) => error.message,
		);
		try {
			await delay(250);
		} finally {
			releaseFirst();
		}
		await first;
		assert.equal(await secondResult, null, "Concurrent admission must wait.");
		assert.deepEqual(events, ["first-enter", "first-exit", "second-enter"]);
		await assert.rejects(
			lockedVm(slug, async () => {
				throw new Error("operation failed");
			}),
			/operation failed/,
		);
		await lockedVm(slug, async () => {
			events.push("recovered");
		});
		const pool = scopedDatabase();
		assert.ok(pool);
		const holder = await pool.connect();
		try {
			await holder.query(
				"select pg_advisory_lock(hashtextextended($1,81738421))",
				[slug],
			);
			await lockedVm(`${slug}-independent`, async () => {
				events.push("independent");
			});
			const waiter = await pool.connect();
			let originalTimeout: string;
			try {
				originalTimeout = (await waiter.query("show statement_timeout")).rows[0]
					.statement_timeout;
			} finally {
				waiter.release();
			}
			let enteredTimedOutOperation = false;
			const waitStarted = Date.now();
			await assert.rejects(
				lockedVm(slug, async () => {
					enteredTimedOutOperation = true;
				}),
				/statement timeout/,
			);
			const waitMs = Date.now() - waitStarted;
			assert.ok(waitMs >= 19_000 && waitMs < 25_000);
			assert.equal(enteredTimedOutOperation, false);
			const replacement = await pool.connect();
			try {
				assert.equal(
					(await replacement.query("show statement_timeout")).rows[0]
						.statement_timeout,
					originalTimeout,
				);
			} finally {
				replacement.release();
			}
			events.push("timeout-replaced-session");
		} finally {
			// Destroy the proof's holder even if its final unlock fails.
			try {
				await holder.query(
					"select pg_advisory_unlock(hashtextextended($1,81738421))",
					[slug],
				);
			} finally {
				holder.release(true);
			}
		}
		console.log(JSON.stringify({ verdict: "pass", events }));
	});
}

await proveAdmissionConcurrency();
