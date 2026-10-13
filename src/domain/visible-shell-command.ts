export function unwrapShellCommand(command: string): string {
	const trimmed = command.trim();
	const wrapped = trimmed.match(/^\/bin\/(?:ba)?sh\s+-lc\s+(['"])([\s\S]*)\1$/);
	const inner = wrapped?.[2]?.trim() ?? trimmed;
	const afterCd = inner.match(/^cd\s+\S+\s+&&\s+([\s\S]+)$/);
	return (afterCd?.[1] ?? inner).trim();
}

export function stripHeredocBodies(command: string): string {
	return command
		.replace(/<<(['"]?)(\w+)\1\n[\s\S]*?\n\2\b/g, "")
		.replace(/<<(['"]?)\w+\1[\s\S]*$/, "")
		.trim();
}
