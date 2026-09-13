import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { z } from "zod";
import { serverConfig } from "../config";
export const seal = (data: string) =>
	symmetricEncrypt({ key: serverConfig().BETTER_AUTH_SECRET, data });
export const unseal = (data: string) =>
	symmetricDecrypt({ key: serverConfig().BETTER_AUTH_SECRET, data });

export const githubCredentials = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional(),
	expiresAt: z.number().finite().nullable(),
});
