import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { unstable_dev } from "wrangler";

it("persists uncertain and completed receipts across workerd restart, with chat isolation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-receipt-test-"));
	const start = () =>
		unstable_dev("tests/fixtures/conversation-step-worker.mjs", {
			config: "tests/fixtures/conversation-step.wrangler.jsonc",
			local: true,
			persistTo: directory,
			logLevel: "error",
			experimental: { disableExperimentalWarning: true },
		});
	let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
	const step = { turnId: "turn-1", leaseId: "lease-1", index: 1 };
	const send = async (chat: string, outcome?: string) => {
		if (!worker) throw new Error("Fixture is not running.");
		return (
			await worker.fetch(`http://localhost/${chat}`, {
				method: "POST",
				body: JSON.stringify({ step, outcome }),
			})
		).json();
	};
	try {
		worker = await start();
		expect(await send("uncertain")).toMatchObject({ kind: "claimed" });
		expect(await send("completed")).toMatchObject({ kind: "claimed" });
		expect(await send("completed", "continue")).toBe(true);
		await worker.stop();
		worker = await start();
		expect(await send("uncertain")).toEqual({ kind: "unavailable" });
		expect(await send("completed")).toEqual({
			kind: "done",
			outcome: "continue",
		});
		expect(await send("other-chat")).toMatchObject({ kind: "claimed" });
	} finally {
		await worker?.stop();
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
