import { seal } from "../auth/token-vault";
import { database } from "./database";

export async function persistVerificationEmail(input: {
	to: string;
	subject: string;
	actionUrl: string;
}) {
	await database().query(
		"insert into auth_email_outbox(to_address, subject, purpose, encrypted_action_url) values($1,$2,$3,$4)",
		[input.to, input.subject, "verify-email", await seal(input.actionUrl)],
	);
}
