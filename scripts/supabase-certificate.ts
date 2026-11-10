import { readFileSync } from "node:fs";

/** Deployment machines can use the configured certificate without writing a secret to disk. */
export function supabaseCertificate(
	env: Readonly<Record<string, string | undefined>> = process.env,
	path = env.SUPABASE_CA_PATH ?? ".secrets/supabase-ca.crt",
) {
	const certificate =
		env.DATABASE_SSL_CA?.trim() ||
		env.SUPABASE_CA_CERT?.trim() ||
		readFileSync(path, "utf8").trim();
	if (!certificate.includes("-----BEGIN CERTIFICATE-----"))
		throw new Error(
			"Set DATABASE_SSL_CA or SUPABASE_CA_CERT to the Supabase CA certificate, or configure a non-empty SUPABASE_CA_PATH.",
		);
	return certificate;
}
