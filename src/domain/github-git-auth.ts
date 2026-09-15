export function githubGitHttpExtraHeader(token: string) {
	const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString(
		"base64",
	);
	return `AUTHORIZATION: basic ${basic}`;
}

export function githubGitHttpEnv(token: string) {
	return {
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: githubGitHttpExtraHeader(token),
	};
}
