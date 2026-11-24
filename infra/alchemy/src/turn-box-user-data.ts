/**
 * The launch template's user data: infra/turn-box/bootstrap.sh with its
 * placeholders filled, exactly as fleet.py built it. It holds no credential
 * (a box enrolls itself, docs/turn-runner-boxes.md).
 */
export function turnBoxUserData(input: {
	readonly bootstrap: string;
	readonly sigv4: string;
	readonly start: string;
	readonly edgeUrl: string;
	readonly logGroup: string;
}): string {
	const values: Record<string, string> = {
		__SIGV4_MJS__: input.sigv4.replace(/\n$/, ""),
		__START_MJS__: input.start.replace(/\n$/, ""),
		__EDGE_URL__: input.edgeUrl,
		__LOG_GROUP__: input.logGroup,
	};
	let script = input.bootstrap;
	for (const [placeholder, value] of Object.entries(values)) {
		if (!script.includes(placeholder))
			throw new Error(`bootstrap.sh no longer has ${placeholder}.`);
		script = script.split(placeholder).join(value);
	}
	const left = script.match(/__[A-Z0-9_]+__/);
	if (left) throw new Error(`bootstrap.sh has an unfilled placeholder ${left[0]}.`);
	// EC2 caps user data at 16 KB before base64.
	if (Buffer.byteLength(script) >= 16_000)
		throw new Error("The turn box user data would exceed 16 KB.");
	return script;
}
