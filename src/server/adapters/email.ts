import { seal } from "../auth/token-vault";
import { database } from "./database";

type AuthEmailPurpose = "verify-email" | "reset-password";

export async function persistAuthEmail(input: {
	to: string;
	subject: string;
	purpose: AuthEmailPurpose;
	actionUrl: string;
}) {
	await database().query(
		"insert into auth_email_outbox(to_address, subject, purpose, encrypted_action_url) values($1,$2,$3,$4)",
		[input.to, input.subject, input.purpose, await seal(input.actionUrl)],
	);
}
