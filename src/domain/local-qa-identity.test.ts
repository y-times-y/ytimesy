import { describe, expect, it } from "vitest";
import {
	authGetSessionPath,
	hostIsLoopback,
	localQaIdentityAllowed,
	preferLocalQaUser,
} from "./local-qa-identity";

describe("local QA identity", () => {
	it("only opens on a development loopback request", () => {
		expect(
			localQaIdentityAllowed({
				nodeEnv: "development",
				host: "127.0.0.1:3000",
			}),
		).toBe(true);
		expect(
			localQaIdentityAllowed({
				nodeEnv: "development",
				host: "localhost:3000",
			}),
		).toBe(true);
		expect(
			localQaIdentityAllowed({
				nodeEnv: "production",
				host: "127.0.0.1:3000",
			}),
		).toBe(false);
		expect(
			localQaIdentityAllowed({
				nodeEnv: "development",
				host: "ytimesy.com",
			}),
		).toBe(false);
		expect(hostIsLoopback("[::1]:3000")).toBe(true);
	});

	it("prefers the GitHub-connected project owner", () => {
		expect(
			preferLocalQaUser([
				{
					id: "fixture",
					github: false,
					hasProject: true,
					lastSessionAt: "2026-09-19T00:00:00.000Z",
				},
				{
					id: "owner",
					github: true,
					hasProject: true,
					lastSessionAt: "2026-09-13T00:00:00.000Z",
				},
			])?.id,
		).toBe("owner");
		expect(preferLocalQaUser([])).toBeNull();
	});

	it("recognizes Better Auth get-session", () => {
		expect(authGetSessionPath("/api/auth/get-session")).toBe(true);
		expect(authGetSessionPath("/api/auth/sign-in/social")).toBe(false);
	});
});
