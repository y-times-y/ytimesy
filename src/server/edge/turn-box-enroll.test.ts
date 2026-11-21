import { describe, expect, it } from "vitest";
import {
	ENROLL_AUDIENCE,
	STS_BODY,
	STS_URL,
	verifiedInstanceId,
} from "./turn-box-enroll";

const config = { accountId: "703705584492", roleName: "ytimesy-box" };
const headers = {
	authorization: "AWS4-HMAC-SHA256 Credential=x",
	"x-amz-date": "20261121T000000Z",
	"x-amz-security-token": "token",
	"x-ytimesy-audience": ENROLL_AUDIENCE,
};
const answer = (arn: string) =>
	(async () =>
		new Response(
			`<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${arn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`,
		)) as unknown as typeof fetch;

describe("verifiedInstanceId", () => {
	it("returns the instance id of the configured account and role", async () => {
		expect(
			await verifiedInstanceId(
				headers,
				config,
				answer(
					"arn:aws:sts::703705584492:assumed-role/ytimesy-box/i-0123456789abcdef0",
				),
			),
		).toBe("i-0123456789abcdef0");
	});

	it("sends only STS the fixed request with the allowed headers", async () => {
		let seen: { url: unknown; init?: RequestInit } | undefined;
		const upstream = (async (url: unknown, init?: RequestInit) => {
			seen = { url, init };
			return new Response("<Arn>x</Arn>");
		}) as unknown as typeof fetch;
		await verifiedInstanceId(
			{ ...headers, host: "evil.test", "x-other": "1" },
			config,
			upstream,
		);
		expect(seen?.url).toBe(STS_URL);
		expect(seen?.init?.body).toBe(STS_BODY);
		const sent = new Headers(seen?.init?.headers);
		expect(sent.get("host")).toBeNull();
		expect(sent.get("x-other")).toBeNull();
	});

	it("refuses another account, role, user, a wrong audience and missing headers", async () => {
		for (const arn of [
			"arn:aws:sts::111111111111:assumed-role/ytimesy-box/i-0123456789abcdef0",
			"arn:aws:sts::703705584492:assumed-role/other/i-0123456789abcdef0",
			"arn:aws:sts::703705584492:assumed-role/ytimesy-box/someone@example.com",
			"arn:aws:iam::703705584492:user/ytimesy-box",
		])
			expect(await verifiedInstanceId(headers, config, answer(arn))).toBeNull();
		const good = answer(
			"arn:aws:sts::703705584492:assumed-role/ytimesy-box/i-0123456789abcdef0",
		);
		expect(
			await verifiedInstanceId(
				{ ...headers, "x-ytimesy-audience": "other" },
				config,
				good,
			),
		).toBeNull();
		expect(
			await verifiedInstanceId({ authorization: "x" }, config, good),
		).toBeNull();
		expect(await verifiedInstanceId(null, config, good)).toBeNull();
	});

	it("refuses when STS rejects the signature", async () => {
		const rejected = (async () =>
			new Response("denied", { status: 403 })) as unknown as typeof fetch;
		expect(await verifiedInstanceId(headers, config, rejected)).toBeNull();
	});
});
