import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	AuthEmailSendError,
	deliverAuthEmails,
	type OutgoingAuthEmail,
	persistAuthEmail,
	sendWithBinding,
	sendWithCloudflare,
	useAuthEmailBinding,
} from "../src/server/adapters/email";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => db.query(sql, params),
	}),
}));
vi.mock("../src/server/config", () => ({
	serverConfig: () => ({
		APP_URL: "http://127.0.0.1:3001",
		BETTER_AUTH_SECRET: "test-only-secret-longer-than-thirty-two-characters",
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const migration of [
		"20260913234500_auth_email_outbox.sql",
		"20260914010000_auth_email_reset_password.sql",
		"20261014040000_auth_email_delivery.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${migration}`, "utf8"));
});
afterAll(() => db.close());
beforeEach(async () => {
	await db.exec("delete from auth_email_outbox");
});

async function queue(to = "alice@example.test") {
	await persistAuthEmail({
		to,
		subject: "Verify your ytimesy email",
		purpose: "verify-email",
		actionUrl: "https://ytimesy.test/verify?token=secret",
	});
}
async function rows() {
	return (
		await db.query<{
			attempts: number;
			sent_at: Date | null;
			failed_at: Date | null;
			encrypted_action_url: string;
			last_error: string | null;
		}>(
			"select attempts,sent_at,failed_at,encrypted_action_url,last_error from auth_email_outbox order by id",
		)
	).rows;
}

it("does not send anything until a sender is configured", async () => {
	await queue();
	expect(await deliverAuthEmails()).toEqual({
		sent: 0,
		retrying: 0,
		failed: 0,
	});
	expect((await rows())[0].attempts).toBe(0);
});

it("sends due mail once, marks it sent and forgets the link", async () => {
	await queue();
	const sent: OutgoingAuthEmail[] = [];
	const send = async (message: OutgoingAuthEmail) => {
		sent.push(message);
	};
	expect(await deliverAuthEmails({ send })).toMatchObject({ sent: 1 });
	expect(sent[0].to).toBe("alice@example.test");
	expect(sent[0].text).toContain("https://ytimesy.test/verify?token=secret");
	const [row] = await rows();
	expect(row.sent_at).not.toBeNull();
	expect(row.encrypted_action_url).toBe("");
	expect(await deliverAuthEmails({ send })).toMatchObject({ sent: 0 });
	expect(sent).toHaveLength(1);
});

it("retries transient failures with backoff and gives up after the cap", async () => {
	await queue();
	const send = vi.fn(async () => {
		throw new AuthEmailSendError("Email service returned 503.", true);
	});
	expect(await deliverAuthEmails({ send })).toMatchObject({ retrying: 1 });
	// The retry is scheduled in the future, so an immediate drain skips it.
	expect(await deliverAuthEmails({ send })).toMatchObject({ retrying: 0 });
	for (let attempt = 0; attempt < 10; attempt++) {
		await db.exec(
			"update auth_email_outbox set next_attempt_at=now()-interval '1 second'",
		);
		await deliverAuthEmails({ send });
	}
	const [row] = await rows();
	expect(row.attempts).toBe(6);
	expect(row.failed_at).not.toBeNull();
	expect(row.last_error).toBe("Email service returned 503.");
	expect(row.encrypted_action_url).toBe("");
	expect(send).toHaveBeenCalledTimes(6);
});

it("gives up immediately on permanent failures and expired links", async () => {
	await queue("bounce@example.test");
	await queue("late@example.test");
	await db.exec(
		"update auth_email_outbox set created_at=now()-interval '2 hours' where to_address='late@example.test'",
	);
	const send = vi.fn(async () => {
		throw new AuthEmailSendError("Recipient address bounced.", false);
	});
	expect(await deliverAuthEmails({ send })).toMatchObject({ failed: 2 });
	expect(send).toHaveBeenCalledOnce();
	expect((await rows()).map((row) => row.last_error)).toEqual([
		"Recipient address bounced.",
		"Link expired before it could be sent.",
	]);
});

it("calls Cloudflare Email Service and classifies its errors", async () => {
	const sender = {
		AUTH_EMAIL_FROM: "auth@ytimesy.test",
		CLOUDFLARE_EMAIL_ACCOUNT_ID: "f".repeat(32),
		CLOUDFLARE_EMAIL_API_TOKEN: "t".repeat(40),
	};
	const message = { to: "a@example.test", subject: "S", text: "T", html: "H" };
	const fetch = vi.spyOn(globalThis, "fetch");
	fetch.mockResolvedValueOnce(
		Response.json({
			success: true,
			errors: [],
			result: { delivered: ["a@example.test"], permanent_bounces: [] },
		}),
	);
	await sendWithCloudflare(sender, message);
	const [url, init] = fetch.mock.calls[0];
	expect(url).toBe(
		`https://api.cloudflare.com/client/v4/accounts/${"f".repeat(32)}/email/sending/send`,
	);
	expect(JSON.parse(String(init?.body))).toMatchObject({
		to: "a@example.test",
		from: { address: "auth@ytimesy.test", name: "ytimesy" },
	});
	fetch.mockResolvedValueOnce(
		Response.json(
			{ success: false, errors: [{ code: 10004, message: "throttled" }] },
			{ status: 429 },
		),
	);
	await expect(sendWithCloudflare(sender, message)).rejects.toMatchObject({
		retryable: true,
	});
	fetch.mockResolvedValueOnce(
		Response.json(
			{ success: false, errors: [{ code: 10101, message: "unauthorized" }] },
			{ status: 401 },
		),
	);
	await expect(sendWithCloudflare(sender, message)).rejects.toMatchObject({
		retryable: false,
	});
	fetch.mockRestore();
});

it("sends through the Workers binding without an API token", async () => {
	const sent: unknown[] = [];
	useAuthEmailBinding({
		send: async (message) => {
			sent.push(message);
			return { messageId: "m1" };
		},
	});
	vi.stubEnv("AUTH_EMAIL_FROM", "noreply@ytimesy.com");
	vi.stubEnv("CLOUDFLARE_EMAIL_API_TOKEN", "");
	try {
		await persistAuthEmail({
			to: "alice@example.test",
			subject: "Verify your email",
			purpose: "verify-email",
			actionUrl: "http://127.0.0.1:3001/verify?token=t",
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			from: { email: "noreply@ytimesy.com", name: "ytimesy" },
			to: "alice@example.test",
			subject: "Verify your email",
		});
		const row = await db.query<{ sent_at: Date | null }>(
			"select sent_at from auth_email_outbox",
		);
		expect(row.rows[0]?.sent_at).not.toBeNull();
	} finally {
		vi.unstubAllEnvs();
	}
});

it("retries binding errors except ones a retry cannot fix", async () => {
	const failing = (code: string) => ({
		send: async () => {
			throw Object.assign(new Error("refused"), { code });
		},
	});
	const message = { to: "a@example.test", subject: "s", text: "t", html: "h" };
	for (const [code, retryable] of [
		["E_RATE_LIMIT_EXCEEDED", true],
		["E_DAILY_LIMIT_EXCEEDED", true],
		["E_CONTENT_TOO_LARGE", false],
	] as const)
		await expect(
			sendWithBinding(failing(code), "noreply@ytimesy.com", message),
		).rejects.toMatchObject({ retryable });
});
