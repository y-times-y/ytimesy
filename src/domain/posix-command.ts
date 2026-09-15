export function posixShellQuoted(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function posixShellCommand(argv: readonly string[]) {
	if (argv.length === 0)
		throw new Error("A command requires at least one argument.");
	return argv.map(posixShellQuoted).join(" ");
}
