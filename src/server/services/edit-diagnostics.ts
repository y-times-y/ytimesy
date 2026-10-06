import ts from "typescript";

/** Syntax feedback only: type safety and behavioral correctness still require project checks. */
export function editDiagnostics(path: string, content: string | undefined) {
	if (
		!/\.(?:[cm]?[jt]sx?)$/.test(path) ||
		/\.d\.[cm]?ts$/.test(path) ||
		content === undefined
	)
		return { syntaxChecked: false, diagnostics: [] as string[] };
	const result = ts.transpileModule(content, {
		fileName: path,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			jsx: ts.JsxEmit.Preserve,
			isolatedModules: true,
		},
	});
	return {
		syntaxChecked: true,
		diagnostics: (result.diagnostics ?? [])
			.filter(
				(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
			)
			.slice(0, 10)
			.map((diagnostic) => {
				const position =
					diagnostic.start === undefined || !diagnostic.file
						? null
						: diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
				return `${position ? `${position.line + 1}:${position.character + 1} ` : ""}${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
			}),
	};
}
