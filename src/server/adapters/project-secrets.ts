import { randomUUID } from "node:crypto";
import type { EncryptedSecret } from "#/domain/encrypted-secret";
import type { PublicProjectSecret } from "#/domain/project-secret";
import { database } from "./database";

export type StoredProjectSecret = PublicProjectSecret & {
	readonly encrypted: EncryptedSecret;
};

export async function listProjectSecretsForOwner(
	userId: string,
	projectId: string,
): Promise<readonly PublicProjectSecret[]> {
	const result = await database().query(
		`select s.id, s.name, s.hint, s.updated_at as "updatedAt"
		 from project_secret s
		 join project p on p.id = s.project_id
		 where s.project_id = $1 and p.user_id = $2
		 order by s.name`,
		[projectId, userId],
	);
	return result.rows.map((row) => ({
		...publicSecret(row),
	}));
}

export async function loadProjectSecretsForOwner(
	userId: string,
	projectId: string,
): Promise<readonly StoredProjectSecret[]> {
	const result = await database().query(
		`select s.id, s.name, s.hint, s.updated_at as "updatedAt",
		        s.encrypted_iv as iv, s.encrypted_tag as tag,
		        s.encrypted_ciphertext as ciphertext, s.encrypted_version as version
		 from project_secret s
		 join project p on p.id = s.project_id
		 where s.project_id = $1 and p.user_id = $2
		 order by s.name`,
		[projectId, userId],
	);
	return result.rows.map(storedSecret);
}

export async function saveProjectSecretForOwner(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly name: string;
	readonly hint: string;
	readonly encrypted: EncryptedSecret;
}): Promise<PublicProjectSecret> {
	const result = await database().query(
		`insert into project_secret(
		   id, project_id, name, hint, encrypted_iv, encrypted_tag,
		   encrypted_ciphertext, encrypted_version, updated_at
		 )
		 select $1, p.id, $2, $3, $4, $5, $6, $7, now()
		 from project p
		 where p.id = $8 and p.user_id = $9
		 on conflict (project_id, name) do update
		   set hint = excluded.hint,
		       encrypted_iv = excluded.encrypted_iv,
		       encrypted_tag = excluded.encrypted_tag,
		       encrypted_ciphertext = excluded.encrypted_ciphertext,
		       encrypted_version = excluded.encrypted_version,
		       updated_at = now()
		 returning id, name, hint, updated_at as "updatedAt"`,
		[
			randomUUID(),
			input.name,
			input.hint,
			input.encrypted.iv,
			input.encrypted.tag,
			input.encrypted.ciphertext,
			input.encrypted.version,
			input.projectId,
			input.userId,
		],
	);
	const row = result.rows[0];
	if (!row) throw new Error("Project is not available.");
	return publicSecret(row);
}

export async function deleteProjectSecretForOwner(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly secretId: string;
}): Promise<void> {
	await database().query(
		`delete from project_secret s
		 using project p
		 where s.id = $1 and s.project_id = p.id and p.id = $2 and p.user_id = $3`,
		[input.secretId, input.projectId, input.userId],
	);
}

function publicSecret(row: {
	id: string;
	name: string;
	hint: string;
	updatedAt: Date | string;
}): PublicProjectSecret {
	return {
		id: row.id,
		name: row.name,
		hint: row.hint,
		updatedAt:
			row.updatedAt instanceof Date
				? row.updatedAt.toISOString()
				: String(row.updatedAt),
	};
}

function storedSecret(row: {
	id: string;
	name: string;
	hint: string;
	updatedAt: Date | string;
	iv: string;
	tag: string;
	ciphertext: string;
	version: number;
}): StoredProjectSecret {
	return {
		...publicSecret(row),
		encrypted: {
			version: 1,
			iv: row.iv,
			tag: row.tag,
			ciphertext: row.ciphertext,
		},
	};
}
