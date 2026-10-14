import { z } from "zod";
import {
	AUTH_EMAIL_MAX_ATTEMPTS,
	type AuthEmailPurpose,
	authEmailContent,
	authEmailExpired,
	authEmailRetryDelayMs,
} from "../../domain/auth-email";
import { seal, unseal } from "../auth/token-vault";
import { database } from "./database";

/**
 * Auth email goes out through Cloudflare Email Service's REST API. All three
 * values are required; without them nothing is sent and the sign-in page hides
 * email sign-up and password reset.
 */
const senderConfiguration = z.object({
	AUTH_EMAIL_FROM: z.email(),
	CLOUDFLARE_EMAIL_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/i),
	CLOUDFLARE_EMAIL_API_TOKEN: z.string().min(20),
});
type AuthEmailSender = z.infer<typeof senderConfiguration>;

function authEmailSender(): AuthEmailSender | null {
	const parsed = senderConfiguration.safeParse(process.env);
	return parsed.success ? parsed.data : null;
}

export function authEmailDeliveryConfigured() {
	return authEmailSender() !== null;
}

export type OutgoingAuthEmail = {
	to: string;
	subject: string;
	text: string;
	html: string;
};

/** A send that failed; `retryable` is false when repeating it cannot help. */
export class AuthEmailSendError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "AuthEmailSendError";
	}
}

const sendResponse = z.object({
	success: z.boolean(),
	errors: z.array(z.object({ code: z.number(), message: z.string() })),
	result: z
		.object({ permanent_bounces: z.array(z.string()).default([]) })
		.nullable()
		.optional(),
});

export async function sendWithCloudflare(
	sender: AuthEmailSender,
	message: OutgoingAuthEmail,
) {
	let response: Response;
	try {
		response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${sender.CLOUDFLARE_EMAIL_ACCOUNT_ID}/email/sending/send`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${sender.CLOUDFLARE_EMAIL_API_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					to: message.to,
					from: { address: sender.AUTH_EMAIL_FROM, name: "ytimesy" },
					subject: message.subject,
					text: message.text,
					html: message.html,
				}),
				signal: AbortSignal.timeout(15_000),
			},
		);
	} catch {
		throw new AuthEmailSendError("Email service unreachable.", true);
	}
	const body = sendResponse.safeParse(await response.json().catch(() => null));
	const detail = body.success
		? body.data.errors
				.map((error) => `${error.code} ${error.message}`)
				.join("; ")
		: "";
	if (!response.ok || !body.success || !body.data.success)
		throw new AuthEmailSendError(
			`Email service returned ${response.status}${detail ? `: ${detail}` : ""}.`,
			response.status === 429 || response.status >= 500,
		);
	if (body.data.result?.permanent_bounces.length)
		throw new AuthEmailSendError("Recipient address bounced.", false);
}

export async function persistAuthEmail(input: {
	to: string;
	subject: string;
	purpose: AuthEmailPurpose;
	actionUrl: string;
}) {
	const queued = await database().query<{ id: string }>(
		"insert into auth_email_outbox(to_address, subject, purpose, encrypted_action_url) values($1,$2,$3,$4) returning id::text",
		[input.to, input.subject, input.purpose, await seal(input.actionUrl)],
	);
	// Send right away so the user is not waiting for the next cron tick; the
	// row stays queued for the retry loop if this attempt fails.
	if (authEmailDeliveryConfigured())
		await deliverAuthEmails({ ids: [queued.rows[0].id] }).catch(() => {
			console.warn("Auth email could not be sent now; it will be retried.");
		});
}

type ClaimedAuthEmail = {
	id: string;
	to_address: string;
	subject: string;
	purpose: AuthEmailPurpose;
	encrypted_action_url: string;
	attempts: number;
	created_at: Date | string;
};

/**
 * Drains due outbox rows: each claimed row is leased for five minutes (so a
 * concurrent drain skips it), sent, and then marked sent, rescheduled with
 * backoff, or given up after AUTH_EMAIL_MAX_ATTEMPTS or once its link expired.
 */
export async function deliverAuthEmails(
	options: {
		ids?: readonly string[];
		limit?: number;
		now?: () => Date;
		send?: (message: OutgoingAuthEmail) => Promise<void>;
	} = {},
) {
	const outcome = { sent: 0, retrying: 0, failed: 0 };
	const sender = authEmailSender();
	const send =
		options.send ??
		(sender
			? (message: OutgoingAuthEmail) => sendWithCloudflare(sender, message)
			: null);
	if (!send) return outcome;
	const now = options.now ?? (() => new Date());
	const claimed = await database().query<ClaimedAuthEmail>(
		`update auth_email_outbox set attempts=attempts+1, next_attempt_at=now()+interval '5 minutes'
		where id in (
			select id from auth_email_outbox
			where sent_at is null and failed_at is null and next_attempt_at<=now()
				and ($1::bigint[] is null or id=any($1::bigint[]))
			order by id limit $2 for update skip locked
		)
		returning id::text,to_address,subject,purpose,encrypted_action_url,attempts,created_at`,
		[options.ids ? [...options.ids] : null, options.limit ?? 25],
	);
	for (const row of claimed.rows) {
		if (authEmailExpired(new Date(row.created_at), now())) {
			await giveUp(row.id, "Link expired before it could be sent.");
			outcome.failed++;
			continue;
		}
		try {
			const actionUrl = await unseal(row.encrypted_action_url);
			await send({
				to: row.to_address,
				subject: row.subject,
				...authEmailContent(row.purpose, actionUrl),
			});
			await database().query(
				"update auth_email_outbox set sent_at=now(), last_error=null, encrypted_action_url='' where id=$1",
				[row.id],
			);
			outcome.sent++;
		} catch (error) {
			const message =
				error instanceof AuthEmailSendError ? error.message : "Send failed.";
			const retryable =
				!(error instanceof AuthEmailSendError) || error.retryable;
			if (retryable && row.attempts < AUTH_EMAIL_MAX_ATTEMPTS) {
				await database().query(
					"update auth_email_outbox set last_error=$2, next_attempt_at=now()+($3::integer * interval '1 millisecond') where id=$1",
					[row.id, message, authEmailRetryDelayMs(row.attempts)],
				);
				outcome.retrying++;
			} else {
				await giveUp(row.id, message);
				outcome.failed++;
			}
		}
	}
	return outcome;
}

async function giveUp(id: string, message: string) {
	await database().query(
		"update auth_email_outbox set failed_at=now(), last_error=$2, encrypted_action_url='' where id=$1",
		[id, message],
	);
}
