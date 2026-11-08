import { expect, it } from "vitest";
import {
	forgetPeerInboxObservation,
	observePeerInbox,
	peerInboxMayHaveMessages,
	queuedMessageSentNow,
} from "./peer-inbox-observation";

it("reports a sent queued message only from a fresh heartbeat after the last inbox write", () => {
	observePeerInbox("chat-sent", 1_000, true, true);
	expect(queuedMessageSentNow("chat-sent", 1_200)).toBe(true);
	expect(queuedMessageSentNow("chat-sent", 2_600)).toBe(false);
	// The step took it: a heartbeat that read the inbox before then is ignored.
	forgetPeerInboxObservation("chat-sent", 3_000);
	observePeerInbox("chat-sent", 2_900, true, true);
	expect(queuedMessageSentNow("chat-sent", 3_100)).toBe(false);
	observePeerInbox("chat-queued", 1_000, true);
	expect(queuedMessageSentNow("chat-queued", 1_100)).toBe(false);
});

it("a fresh heartbeat that found nothing lets a step skip the inbox read", () => {
	observePeerInbox("chat-empty", 1_000, false);
	expect(peerInboxMayHaveMessages("chat-empty", 1_200)).toBe(false);
	expect(peerInboxMayHaveMessages("chat-empty", 2_600)).toBe(true);
});

it("a heartbeat in flight across this isolate's own inbox write does not hide it", () => {
	// Lead mode fusion: a heartbeat starts and reads an empty inbox; the
	// gate then stages the exploration report and Main's model call follows
	// at once, before that heartbeat's answer lands. The answer predates the
	// write, so the step still reads the inbox and Main's first call carries
	// the report.
	const heartbeatStarted = 10_000;
	forgetPeerInboxObservation("chat-race", 10_200);
	observePeerInbox("chat-race", heartbeatStarted, false);
	expect(peerInboxMayHaveMessages("chat-race", 10_300)).toBe(true);
	// The same clock reading (a frozen isolate clock) does not prove it either.
	forgetPeerInboxObservation("chat-tie", 20_000);
	observePeerInbox("chat-tie", 20_000, false);
	expect(peerInboxMayHaveMessages("chat-tie", 20_100)).toBe(true);
	// A heartbeat started after the write answers for it.
	observePeerInbox("chat-race", 10_400, false);
	expect(peerInboxMayHaveMessages("chat-race", 10_500)).toBe(false);
});
