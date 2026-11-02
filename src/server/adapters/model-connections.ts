import { randomUUID } from "node:crypto";
import type { PublicModelConnection } from "#/domain/model-connection";
import { xaiSubscriptionEnabled } from "#/domain/xai-subscription";
import { database } from "./database";

export type StoredModelConnection = PublicModelConnection & {
	sealedCredential: string;
};
const PUBLIC_COLUMNS = `id,provider,label,base_url as "baseUrl",models,revision,
	case when kind='xai-subscription' then jsonb_build_object('provider','xai','status',status) end as subscription`;

/** A SuperGrok subscription row exists only for its feature switch: off, nothing reads it. */
function visibleKinds() {
	return xaiSubscriptionEnabled() ? "" : " and kind='key'";
}

function publicRow<T extends PublicModelConnection>(
	row: T & { subscription?: PublicModelConnection["subscription"] | null },
): T {
	const { subscription, ...rest } = row;
	return (subscription ? { ...rest, subscription } : rest) as T;
}

export async function listModelConnections(
	userId: string,
): Promise<PublicModelConnection[]> {
	return (
		await database().query<PublicModelConnection>(
			`select ${PUBLIC_COLUMNS} from model_connection where user_id=$1${visibleKinds()} order by created_at,id`,
			[userId],
		)
	).rows.map(publicRow);
}

export async function loadModelConnection(
	userId: string,
	id: string,
): Promise<StoredModelConnection | null> {
	const result = await database().query<StoredModelConnection>(
		`select ${PUBLIC_COLUMNS}, sealed_credential as "sealedCredential" from model_connection where user_id=$1 and id=$2${visibleKinds()}`,
		[userId, id],
	);
	const row = result.rows[0];
	return row ? publicRow(row) : null;
}

export async function saveModelConnection(
	userId: string,
	input: Omit<StoredModelConnection, "revision">,
	replacing: boolean,
): Promise<void> {
	const values = [
		input.id,
		userId,
		input.provider,
		input.label,
		input.baseUrl,
		input.sealedCredential,
		JSON.stringify(input.models),
		randomUUID(),
	];
	const result = replacing
		? await database().query(
				`update model_connection set provider=$3,label=$4,base_url=$5,sealed_credential=$6,models=$7::jsonb,revision=$8,updated_at=now() where id=$1 and user_id=$2 and kind='key' returning id`,
				values,
			)
		: await database().query(
				`insert into model_connection(id,user_id,provider,label,base_url,sealed_credential,models,revision) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8) returning id`,
				values,
			);
	if (!result.rows[0]) throw new Error("Connection not available.");
}

export async function removeModelConnection(
	userId: string,
	id: string,
): Promise<void> {
	await database().query(
		"delete from model_connection where user_id=$1 and id=$2",
		[userId, id],
	);
}

export async function claimModelProbe(
	userId: string,
	id: string,
	revision: string,
): Promise<boolean> {
	const result = await database().query(
		`update model_connection set last_probe_at=now() where user_id=$1 and id=$2 and revision=$3 and (last_probe_at is null or last_probe_at < now()-interval '30 seconds') returning id`,
		[userId, id, revision],
	);
	return result.rows.length === 1;
}

export async function markModelVerified(
	userId: string,
	id: string,
	revision: string,
	modelId: string,
): Promise<boolean> {
	const result = await database().query(
		`update model_connection set models=(select jsonb_agg(case when model->>'id'=$4 then model || '{"toolStreamingVerified":true}'::jsonb else model end) from jsonb_array_elements(models) model),updated_at=now() where user_id=$1 and id=$2 and revision=$3 returning id`,
		[userId, id, revision, modelId],
	);
	return result.rows.length === 1;
}
