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
	/**
	 * final, grading (tests still running on graderVmId), error, or for a
	 * detached run queued (waiting for a model slot) and running (its turn is
	 * on the edge, or its finalize was interrupted).
	 */
	status: "final" | "grading" | "error" | "queued" | "running";
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

/**
 * Scored = graded, not skipped, no usage limit or infrastructure failure,
 * full agent budget. One rule, shared with scripts/hard-set.ts.
 */
export { isScored } from "./scoring";
