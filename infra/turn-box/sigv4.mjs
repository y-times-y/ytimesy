// Signs an STS GetCallerIdentity request (AWS Signature Version 4) with an
// instance role's credentials. The edge replays it to STS to learn which
// instance sent it (src/server/edge/turn-box-enroll.ts).
import { createHash, createHmac } from "node:crypto";

export const AUDIENCE = "ytimesy-turn-box-edge";
export const BODY = "Action=GetCallerIdentity&Version=2011-06-15";
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** The headers the edge forwards: `stamp` is YYYYMMDDTHHMMSSZ. */
export function signStsRequest({ accessKeyId, secretAccessKey, token, stamp }) {
	const day = stamp.slice(0, 8);
	const headers = {
		"content-type": "application/x-www-form-urlencoded; charset=utf-8",
		host: "sts.amazonaws.com",
		"x-amz-date": stamp,
		"x-amz-security-token": token,
		"x-ytimesy-audience": AUDIENCE,
	};
	const names = Object.keys(headers).sort();
	const canonical = [
		"POST",
		"/",
		"",
		names.map((name) => `${name}:${headers[name]}\n`).join(""),
		names.join(";"),
		sha(BODY),
	].join("\n");
	const scope = `${day}/us-east-1/sts/aws4_request`;
	const key = hmac(
		hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), "us-east-1"), "sts"),
		"aws4_request",
	);
	const signature = createHmac("sha256", key)
		.update(["AWS4-HMAC-SHA256", stamp, scope, sha(canonical)].join("\n"))
		.digest("hex");
	return {
		authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
		"x-amz-date": stamp,
		"x-amz-security-token": token,
		"x-ytimesy-audience": AUDIENCE,
	};
}
