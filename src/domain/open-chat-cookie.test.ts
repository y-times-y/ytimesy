import { describe, expect, it } from "vitest";
import { openChatCookie, openChatFromCookies } from "./open-chat-cookie";

const P = "11111111-2222-4333-8444-555555555555";
const C = "66666666-7777-4888-9999-aaaaaaaaaaaa";

describe("open chat cookie", () => {
	it("reopens the chat it saved and ignores anything else", () => {
		const cookie = openChatCookie(P, C).split(";")[0];
		expect(openChatFromCookies(`a=1; ${cookie}`)).toEqual({
			projectId: P,
			chatId: C,
		});
		expect(openChatCookie(P)).toContain("max-age=0");
		expect(openChatFromCookies(`ytimesy-open-chat=${P}~x`)).toBeUndefined();
		expect(openChatFromCookies(undefined)).toBeUndefined();
	});
});
