import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { supabaseCertificate } from "../scripts/supabase-certificate";

const certificate =
	"-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----";

it("uses configured certificate values without requiring a local file", () => {
	expect(
		supabaseCertificate({ DATABASE_SSL_CA: certificate }, "/missing/ca.crt"),
	).toBe(certificate);
	expect(
		supabaseCertificate({ SUPABASE_CA_CERT: certificate }, "/missing/ca.crt"),
	).toBe(certificate);
	expect(
		supabaseCertificate({
			DATABASE_SSL_CA: certificate,
			SUPABASE_CA_CERT: "wrong",
		}),
	).toBe(certificate);
});

it("retains the file fallback and rejects empty certificate files", () => {
	const directory = mkdtempSync(join(tmpdir(), "ytimesy-ca-test-"));
	const path = join(directory, "ca.crt");
	try {
		writeFileSync(path, `${certificate}\n`);
		expect(supabaseCertificate({}, path)).toBe(certificate);
		writeFileSync(path, "\n");
		expect(() => supabaseCertificate({}, path)).toThrow(
			"non-empty SUPABASE_CA_PATH",
		);
		expect(supabaseCertificate({ SUPABASE_CA_CERT: certificate }, path)).toBe(
			certificate,
		);
	} finally {
		rmSync(directory, { recursive: true });
	}
});
