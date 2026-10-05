import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	driveModelWorkflow,
	type WorkflowStep,
	type WorkflowStepOutcome,
	workflowTurnSchema,
} from "../src/domain/model-workflow";
import {
	claimModelWorkflowStep,
	completeModelWorkflowStep,
} from "../src/server/adapters/model-workflow-steps";

let db: PGlite;
const query = async (sql: string, params: unknown[] = []) => {
	const result = await db.query(sql, params);
	return {
		...result,
		rowCount: result.rows.length || result.affectedRows || 0,
	};
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));
const request: WorkflowStep = {
	turnId: "00000000-0000-4000-8000-000000000001",
	leaseId: "00000000-0000-4000-8000-000000000002",
	index: 1,
};
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table api_turn(id uuid primary key,lease_id uuid,state text,cancel_requested boolean,heartbeat_at timestamptz);`);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261004010000_model_workflow_steps.sql",
			"utf8",
		),
	);
}, 15_000);
beforeEach(async () => {
	await db.exec("truncate api_turn cascade");
	await query("insert into api_turn values($1,$2,'running',false,now())", [
		request.turnId,
		request.leaseId,
	]);
});
afterAll(async () => {
	await db.close();
});

it("never re-executes a processing receipt and reuses a confirmed outcome", async () => {
	const claim = await claimModelWorkflowStep(request);
	expect(claim.kind).toBe("claimed");
	if (claim.kind === "claimed")
		expect(claim.remainingMs).toBeGreaterThan(1_790_000);
	expect(await claimModelWorkflowStep(request)).toEqual({
		kind: "unavailable",
	});
	await completeModelWorkflowStep(request, "continue");
	expect(await claimModelWorkflowStep(request)).toEqual({
		kind: "done",
		outcome: "continue",
	});
	expect((await claimModelWorkflowStep({ ...request, index: 2 })).kind).toBe(
		"claimed",
	);
});

it("rejects skipped steps, different leases, cancellation and lost ownership", async () => {
	expect((await claimModelWorkflowStep({ ...request, index: 2 })).kind).toBe(
		"unavailable",
	);
	expect(
		(
			await claimModelWorkflowStep({
				...request,
				leaseId: "00000000-0000-4000-8000-000000000003",
			})
		).kind,
	).toBe("unavailable");
	await query("update api_turn set cancel_requested=true");
	expect((await claimModelWorkflowStep(request)).kind).toBe("cancelled");
	await query(
		"update api_turn set cancel_requested=false,heartbeat_at=now()-interval '46 seconds'",
	);
	expect((await claimModelWorkflowStep(request)).kind).toBe("unavailable");
});

it("recovers a known terminal turn even if the last receipt response was lost", async () => {
	await claimModelWorkflowStep(request);
	await query("update api_turn set state='completed'");
	expect(await claimModelWorkflowStep(request)).toEqual({
		kind: "done",
		outcome: "completed",
	});
});

it("keeps one turn deadline across steps and never continues a terminal receipt", async () => {
	await claimModelWorkflowStep(request);
	await query(
		"update model_workflow_step set started_at=now()-interval '31 minutes'",
	);
	await completeModelWorkflowStep(request, "continue");
	const next = await claimModelWorkflowStep({ ...request, index: 2 });
	expect(next).toMatchObject({ kind: "claimed", remainingMs: 0 });
	await completeModelWorkflowStep({ ...request, index: 2 }, "failed");
	expect((await claimModelWorkflowStep({ ...request, index: 3 })).kind).toBe(
		"unavailable",
	);
});

it("denies browser access to receipts", async () => {
	const result = await query(`select relrowsecurity,
	 has_table_privilege('authenticated','model_workflow_step','select') as can_read
	 from pg_class where relname='model_workflow_step'`);
	expect(result.rows[0]).toEqual({ relrowsecurity: true, can_read: false });
});

it("durable replay skips finished callbacks and stops on the terminal outcome", async () => {
	const saved = new Map<string, WorkflowStepOutcome>();
	const execute = vi.fn(async (step: WorkflowStep) =>
		step.index === 1 ? ("continue" as const) : ("completed" as const),
	);
	const recorded = async (
		name: string,
		run: () => Promise<WorkflowStepOutcome>,
	) => {
		const previous = saved.get(name);
		if (previous) return previous;
		const result = await run();
		saved.set(name, result);
		return result;
	};
	const turn = { turnId: request.turnId, leaseId: request.leaseId };
	expect(await driveModelWorkflow(turn, recorded, execute)).toEqual({
		outcome: "completed",
	});
	expect(await driveModelWorkflow(turn, recorded, execute)).toEqual({
		outcome: "completed",
	});
	expect(execute).toHaveBeenCalledTimes(2);
	expect(
		workflowTurnSchema.safeParse({ ...turn, apiKey: "not-allowed" }).success,
	).toBe(false);
});

it("does not retry unknown side effects, and performs a no-inference terminal step at the limit", async () => {
	const failure = vi.fn(async () => {
		throw new Error("uncertain");
	});
	const recorded = async (
		_name: string,
		run: () => Promise<WorkflowStepOutcome>,
	) => run();
	await expect(driveModelWorkflow(request, recorded, failure)).rejects.toThrow(
		"uncertain",
	);
	expect(failure).toHaveBeenCalledTimes(1);
	const bounded = vi.fn(async (step: WorkflowStep) =>
		step.index === 31 ? ("failed" as const) : ("continue" as const),
	);
	expect(await driveModelWorkflow(request, recorded, bounded)).toEqual({
		outcome: "failed",
	});
	expect(bounded).toHaveBeenCalledTimes(31);
});
