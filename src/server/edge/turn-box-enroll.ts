/**
 * How an EC2 runner box gets its identity (docs/turn-runner-boxes.md,
 * "Enrollment"). The box signs an STS GetCallerIdentity request with its
 * instance role's credentials and sends only the signature headers; the edge
 * builds the request itself (a fixed URL and body, so nothing here can be
 * pointed elsewhere), sends it to STS, and reads who AWS says signed it:
 * `arn:aws:sts::<account>:assumed-role/<role>/<instance id>`. The instance id
 * becomes the box id (revocable like any other). Nothing is trusted from the
 * box but what STS confirms.
 */
export const STS_URL = "https://sts.amazonaws.com/";
export const STS_BODY = "Action=GetCallerIdentity&Version=2011-06-15";
/** Signed into the request, so a signature made for another service is useless here. */
export const ENROLL_AUDIENCE = "ytimesy-turn-box-edge";

/** The headers the box may send; the edge passes these and no others. */
const ALLOWED_HEADERS = [
	"authorization",
	"x-amz-date",
	"x-amz-security-token",
	"x-ytimesy-audience",
] as const;

export type AwsEnrollmentConfig = {
	readonly accountId: string;
	readonly roleName: string;
};

export function awsEnrollmentConfig(
	env: Record<string, unknown>,
): AwsEnrollmentConfig | null {
	const accountId = env.TURN_BOX_AWS_ACCOUNT_ID;
	const roleName =
		typeof env.TURN_BOX_AWS_ROLE === "string" && env.TURN_BOX_AWS_ROLE
			? env.TURN_BOX_AWS_ROLE
			: "ytimesy-box";
	return typeof accountId === "string" && /^\d{12}$/.test(accountId)
		? { accountId, roleName }
		: null;
}

/** The instance id STS vouches for, or null: wrong account, role, shape or answer. */
export async function verifiedInstanceId(
	headers: unknown,
	config: AwsEnrollmentConfig,
	upstream: typeof fetch = fetch,
): Promise<string | null> {
	if (!headers || typeof headers !== "object" || Array.isArray(headers))
		return null;
	const given = headers as Record<string, unknown>;
	const send = new Headers({
		"content-type": "application/x-www-form-urlencoded; charset=utf-8",
	});
	for (const name of ALLOWED_HEADERS) {
		const value = given[name];
		if (typeof value !== "string" || value.length > 2048) return null;
		// A role session always carries a token; the audience must be ours.
		send.set(name, value);
	}
	if (send.get("x-ytimesy-audience") !== ENROLL_AUDIENCE) return null;
	const response = await upstream(STS_URL, {
		method: "POST",
		headers: send,
		body: STS_BODY,
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	const arn = /<Arn>([^<]{1,300})<\/Arn>/.exec(await response.text())?.[1];
	const match =
		arn &&
		new RegExp(
			`^arn:aws:sts::${config.accountId}:assumed-role/${config.roleName.replace(/[^A-Za-z0-9_+=,.@-]/g, "")}/(i-[0-9a-f]{8,32})$`,
		).exec(arn);
	return match ? match[1] : null;
}
