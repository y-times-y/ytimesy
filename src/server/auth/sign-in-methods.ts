import { type SignInMethod, signInMethods } from "../../domain/sign-in-methods";
import { database } from "../adapters/database";

/** The ways this user can sign in (Settings > Account). */
export async function loadSignInMethods(
	userId: string,
): Promise<readonly SignInMethod[]> {
	const result = await database().query<{ providerId: string }>(
		'select "providerId" from auth_account where "userId"=$1',
		[userId],
	);
	return signInMethods(result.rows.map((row) => row.providerId));
}
