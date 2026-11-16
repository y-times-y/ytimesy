import { afterEach, describe, expect, it } from "vitest";
import {
	claudeFeedStepMayPause,
	claudeTurnMayPause,
	claudeTurnRedaction,
	forgetClaudeTurn,
	registerClaudeTurn,
	rememberClaudeTurnRedaction,
	requestClaudeStepPause,
	takeClaudeStepPause,
} from "./claude-step-pause";

const TURN = "22222222-2222-4222-8222-222222222222";

describe("when a Claude Code step may sleep", () => {
	afterEach(() => {
		delete process.env.YTIMESY_CLAUDE_STEP_PAUSE;
		forgetClaudeTurn(TURN);
	});

	it("lets a feed step sleep while watched, a polling step only unwatched", () => {
		let watched = true;
		const unregister = registerClaudeTurn(TURN, { watched: () => watched });
		expect(claudeTurnMayPause(TURN)).toBe(false);
		expect(claudeFeedStepMayPause(TURN)).toBe(true);
		watched = false;
		expect(claudeTurnMayPause(TURN)).toBe(true);
		unregister();
		expect(claudeFeedStepMayPause(TURN)).toBe(false);
	});

	it("keeps both off with the off switch", () => {
		process.env.YTIMESY_CLAUDE_STEP_PAUSE = "0";
		const unregister = registerClaudeTurn(TURN, { watched: () => false });
		expect(claudeTurnMayPause(TURN)).toBe(false);
		expect(claudeFeedStepMayPause(TURN)).toBe(false);
		unregister();
	});

	it("keeps the turn's redaction list for previews until the turn ends", () => {
		expect(claudeTurnRedaction(TURN)).toBeUndefined();
		rememberClaudeTurnRedaction(TURN, () => ["hunter2"]);
		expect(claudeTurnRedaction(TURN)?.()).toEqual(["hunter2"]);
		requestClaudeStepPause(TURN, 15_000);
		forgetClaudeTurn(TURN);
		expect(claudeTurnRedaction(TURN)).toBeUndefined();
		expect(takeClaudeStepPause(TURN)).toBe(0);
	});
});
