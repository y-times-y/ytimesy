import { symmetricDecrypt } from "better-auth/crypto";
import { z } from "zod";
import {
	isVersionedSeal,
	openVersioned,
	type SealBinding,
	sealVersioned,
	vaultKeys,
} from "#/domain/sealed-token";
import { vaultConfig } from "../config";

export type { SealBinding };

const keys = () => {
	const config = vaultConfig();
	return vaultKeys({
		BETTER_AUTH_SECRET: config.BETTER_AUTH_SECRET,
		TOKEN_VAULT_KEY: config.TOKEN_VAULT_KEY,
	});
};

/** New writes use the versioned format, bound to purpose + userId when given. */
export const seal = async (data: string, binding?: SealBinding) =>
	sealVersioned(keys(), data, binding);

/** Opens versioned blobs (binding must match) and legacy better-auth blobs. */
export const unseal = async (data: string, binding?: SealBinding) =>
	isVersionedSeal(data)
		? openVersioned(keys(), data, binding)
		: symmetricDecrypt({ key: vaultConfig().BETTER_AUTH_SECRET, data });

export const githubCredentials = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional(),
	expiresAt: z.number().finite().nullable(),
});
