import { randomUUID } from "node:crypto";
import type { EncryptedSecret } from "#/domain/encrypted-secret";
import type {
	ProjectSecretKind,
	PublicProjectSecret,
} from "#/domain/project-secret";
import { database } from "./database";

type StoredProjectSecret = PublicProjectSecret & {
	readonly encrypted: EncryptedSecret;
};

export async function listProjectSecretsForOwner(
	userId: string,
	projectId: string,
): Promise<readonly PublicProjectSecret[]> {
	const result = await database().query(
		`select s.id, s.name, s.kind, s.hint, s.updated_at as "updatedAt",
		        s.imported_at is not null as imported
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
		`select s.id, s.name, s.kind, s.hint, s.description, s.updated_at as "updatedAt",
		        s.imported_at is not null as imported,
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
	readonly kind: ProjectSecretKind;
	readonly hint: string;
	readonly encrypted: EncryptedSecret;
	/** Read from a local .env by "Continue your agent session": shown for review. A save from Settings clears it. */
	readonly imported?: boolean;
}): Promise<PublicProjectSecret> {
	const result = await database().query(
		`insert into project_secret(
		   id, project_id, name, hint, encrypted_iv, encrypted_tag,
		   encrypted_ciphertext, encrypted_version, kind, updated_at, imported_at
		 )
		 select $1, p.id, $2, $3, $4, $5, $6, $7, $10, now(),
		        case when $11::boolean then now() end
		 from project p
		 where p.id = $8 and p.user_id = $9
		 on conflict (project_id, name) do update
		   set hint = excluded.hint,
		       kind = excluded.kind,
		       encrypted_iv = excluded.encrypted_iv,
		       encrypted_tag = excluded.encrypted_tag,
		       encrypted_ciphertext = excluded.encrypted_ciphertext,
		       encrypted_version = excluded.encrypted_version,
		       imported_at = excluded.imported_at,
		       description = null,
		       updated_at = now()
		 returning id, name, kind, hint, updated_at as "updatedAt",
		           imported_at is not null as imported`,
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
			input.kind,
			input.imported === true,
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
	kind: ProjectSecretKind;
	hint: string;
	description?: string | null;
	updatedAt: Date | string;
	imported?: boolean;
}): PublicProjectSecret {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		hint: row.hint,
		...(row.description ? { description: row.description } : {}),
		...(row.imported ? { imported: true } : {}),
		updatedAt:
			row.updatedAt instanceof Date
				? row.updatedAt.toISOString()
				: String(row.updatedAt),
	};
}

function storedSecret(row: {
	id: string;
	name: string;
	kind: ProjectSecretKind;
	hint: string;
	description?: string | null;
	updatedAt: Date | string;
	imported?: boolean;
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

/** Secrets the user shares with all their projects; a project's own secret of the same name wins. */
export async function loadAccountSecrets(
	userId: string,
): Promise<readonly StoredProjectSecret[]> {
	const result = await database().query(
		`select id, name, kind, hint, description, updated_at as "updatedAt",
		        encrypted_iv as iv, encrypted_tag as tag,
		        encrypted_ciphertext as ciphertext, encrypted_version as version
		 from account_secret
		 where user_id = $1
		 order by name`,
		[userId],
	);
	return result.rows.map(storedSecret);
}

export async function saveAccountSecret(input: {
	readonly userId: string;
	readonly name: string;
	readonly kind: ProjectSecretKind;
	readonly hint: string;
	readonly encrypted: EncryptedSecret;
}): Promise<PublicProjectSecret> {
	const result = await database().query(
		`insert into account_secret(
		   id, user_id, name, hint, encrypted_iv, encrypted_tag,
		   encrypted_ciphertext, encrypted_version, kind, updated_at
		 )
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
		 on conflict (user_id, name) do update
		   set hint = excluded.hint,
		       kind = excluded.kind,
		       encrypted_iv = excluded.encrypted_iv,
		       encrypted_tag = excluded.encrypted_tag,
		       encrypted_ciphertext = excluded.encrypted_ciphertext,
		       encrypted_version = excluded.encrypted_version,
		       description = null,
		       updated_at = now()
		 returning id, name, kind, hint, updated_at as "updatedAt"`,
		[
			randomUUID(),
			input.userId,
			input.name,
			input.hint,
			input.encrypted.iv,
			input.encrypted.tag,
			input.encrypted.ciphertext,
			input.encrypted.version,
			input.kind,
		],
	);
	return publicSecret(result.rows[0]);
}

export async function deleteAccountSecret(input: {
	readonly userId: string;
	readonly secretId: string;
}): Promise<void> {
	await database().query(
		"delete from account_secret where id = $1 and user_id = $2",
		[input.secretId, input.userId],
	);
}

export async function listAccountSecrets(
	userId: string,
): Promise<readonly PublicProjectSecret[]> {
	const result = await database().query(
		`select id, name, kind, hint, updated_at as "updatedAt"
		 from account_secret where user_id = $1 order by name`,
		[userId],
	);
	return result.rows.map(publicSecret);
}

/**
 * Saves what an agent learned by testing a secret (never a value). The
 * project's own secret of that name wins over an account-wide one, as when the
 * turn loads them. Returns where it was saved, or null when there is no such secret.
 */
export async function setSecretDescription(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly name: string;
	readonly description: string;
}): Promise<"project" | "account" | null> {
	const own = await database().query(
		`update project_secret s set description = $4
		 from project p
		 where s.project_id = p.id and p.id = $1 and p.user_id = $2 and s.name = $3`,
		[input.projectId, input.userId, input.name, input.description],
	);
	if (own.rowCount) return "project";
	const shared = await database().query(
		"update account_secret set description = $3 where user_id = $1 and name = $2",
		[input.userId, input.name, input.description],
	);
	return shared.rowCount ? "account" : null;
}
