/**
 * The header a pasted MCP credential is sent as. A bare token or API key is a
 * bearer token; "Bearer …" and "Basic …" are used as given; "Header-Name: value"
 * sends that header instead (services such as Datadog want their own).
 */
export function mcpTokenHeaders(input: string): Record<string, string> {
	const token = input.trim();
	if (!token) return {};
	const named = /^([A-Za-z0-9-]{1,64}):\s*(\S.*)$/.exec(token);
	if (named && !/^(bearer|basic)$/i.test(named[1]))
		return { [named[1]]: named[2].trim() };
	return {
		Authorization: /^(Bearer|Basic) /i.test(token) ? token : `Bearer ${token}`,
	};
}
