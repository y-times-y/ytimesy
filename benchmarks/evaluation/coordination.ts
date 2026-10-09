import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_dev } from "wrangler";
import { coordinateConversationTurn } from "../../src/server/adapters/conversation-turn-control";

/** Evaluations retain production lease fencing without contacting shared infrastructure. */
export async function startEvaluationCoordinator() {
	const storage = await mkdtemp(
		join(tmpdir(), "ytimesy-evaluation-coordinator-"),
	);
	const previous = {
		url: process.env.YTIMESY_REALTIME_URL,
		secret: process.env.YTIMESY_REALTIME_SECRET,
	};
	let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		try {
			await worker?.stop();
		} finally {
			for (const [name, value] of Object.entries({
				YTIMESY_REALTIME_URL: previous.url,
				YTIMESY_REALTIME_SECRET: previous.secret,
			})) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await rm(storage, { recursive: true, force: true });
		}
	};
	try {
		const secret = randomBytes(32).toString("hex");
		worker = await unstable_dev("src/realtime/worker.ts", {
			config: "wrangler.realtime.jsonc",
			envFiles: [],
			vars: { DELIVERY_SECRET: secret },
			ip: "127.0.0.1",
			port: 0,
			inspectorPort: 0,
			local: true,
			persist: true,
			persistTo: storage,
			logLevel: "error",
			experimental: {
				disableExperimentalWarning: true,
				disableDevRegistry: true,
				watch: false,
			},
		});
		process.env.YTIMESY_REALTIME_URL = `http://127.0.0.1:${worker.port}`;
		process.env.YTIMESY_REALTIME_SECRET = secret;
		const turn = {
			userId: "evaluation-preflight",
			sessionId: randomUUID(),
			turnId: randomUUID(),
			leaseId: randomUUID(),
		};
		for (const action of ["acquire", "renew", "release"] as const)
			if (!(await coordinateConversationTurn(action, turn)))
				throw new Error("Isolated coordinator preflight rejected its lease.");
		return {
			close,
			preflight: {
				local: true,
				runtime: "durable-object",
				acquire: true,
				renew: true,
				release: true,
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
