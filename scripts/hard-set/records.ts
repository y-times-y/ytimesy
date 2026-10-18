// A hard-set record (.ytimesy/hard-set/<run>/<task>.<attempt>.json) and when
// it counts, shared by scripts/hard-set.ts and scripts/instruction-tuning.ts.
import type { RunRecord } from "../smoke/builder-harness";

export type HardSetRecord = RunRecord & {
	run: string;
	attempt: string;
	category: string;
	mode: string;
	variant: string;
	reasoning: string | null;
	startedAt: string;
	reward: number | null;
	passed: boolean;
	/** final, grading (tests still running on graderVmId), or error. */
	status: "final" | "grading" | "error";
	setupSec: number;
	agentSec: number;
	agentBudgetSec: number;
	agentRequestedSec: number;
	stageSec: number;
	gradeSec: number;
	testsExit: number | null;
	testsTail: string;
	gradeError: string | null;
	usageLimit: string | null;
	vmResources: string | null;
	graderVmId: string | null;
	gradeStartedAt: string | null;
	gradeTimeoutSec: number | null;
};

/** Scored = graded, not skipped, not stopped by a usage limit, full agent budget. */
export const isScored = (record: HardSetRecord) =>
	record.status === "final" &&
	record.state !== "skipped" &&
	!record.usageLimit &&
	record.reward !== null &&
	record.agentBudgetSec >= record.agentRequestedSec - 30;
