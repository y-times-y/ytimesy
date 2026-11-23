import { expect, it, vi } from "vitest";
import { dispatchBackgroundJob } from "../adapters/background-job-dispatch";
import { withDatabaseScope } from "../adapters/database-scope";
import { turnBoxRequestScope } from "./turn-box-scope";

it("gives a box port request the edge's job binding, so a helper message never reaches pg-boss", async () => {
	const dispatch = vi.fn(async () => {});
	const scope = turnBoxRequestScope(
		"postgres://box:box@127.0.0.1:1/box",
		dispatch,
	);
	const job = {
		id: "00000000-0000-4000-8000-000000000001",
		kind: "peer-message" as const,
		userId: "user",
		senderId: "00000000-0000-4000-8000-000000000002",
		recipientId: "00000000-0000-4000-8000-000000000003",
		message: "next step",
	};
	expect(await scope(() => dispatchBackgroundJob(job as never))).toBe(true);
	expect(dispatch).toHaveBeenCalledOnce();
	// The scope box requests had before: no binding, so the job went to pg-boss.
	expect(
		await withDatabaseScope(
			"postgres://box:box@127.0.0.1:1/box",
			() => dispatchBackgroundJob(job as never),
			null,
		),
	).toBe(false);
});
