import type { SourceLanguage } from "./source-language";

export type SourceTokenKind =
	| "identifier"
	| "keyword"
	| "string"
	| "number"
	| "function"
	| "property"
	| "class"
	| "entity"
	| "sign"
	| "comment";

export type SourceToken = {
	readonly kind: SourceTokenKind;
	readonly text: string;
};

const JAVASCRIPT_KEYWORDS = new Set([
	"abstract",
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"declare",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"from",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"infer",
	"instanceof",
	"interface",
	"is",
	"keyof",
	"let",
	"new",
	"null",
	"of",
	"override",
	"package",
	"private",
	"protected",
	"public",
	"readonly",
	"return",
	"satisfies",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"type",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"any",
	"unknown",
	"never",
	"bigint",
	"symbol",
	"object",
	"number",
	"string",
	"boolean",
	"unique",
	"asserts",
	"namespace",
	"module",
	"require",
]);

const PYTHON_KEYWORDS = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
]);

const JSON_KEYWORDS = new Set(["true", "false", "null"]);

const RUST_KEYWORDS = new Set([
	"as",
	"async",
	"await",
	"break",
	"const",
	"continue",
	"crate",
	"dyn",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"self",
	"Self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
]);

const GO_KEYWORDS = new Set([
	"break",
	"case",
	"chan",
	"const",
	"continue",
	"default",
	"defer",
	"else",
	"fallthrough",
	"for",
	"func",
	"go",
	"goto",
	"if",
	"import",
	"interface",
	"map",
	"package",
	"range",
	"return",
	"select",
	"struct",
	"switch",
	"type",
	"var",
	"true",
	"false",
	"nil",
]);

const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"do",
	"done",
	"in",
	"while",
	"case",
	"esac",
	"export",
	"local",
	"return",
	"function",
	"source",
	"true",
	"false",
]);

const SHELL_COMMANDS = new Set([
	"cd",
	"ls",
	"echo",
	"cat",
	"mkdir",
	"rm",
	"cp",
	"mv",
	"git",
	"npm",
	"pnpm",
	"bun",
	"cargo",
	"go",
	"python",
	"node",
	"curl",
	"wget",
]);

const CSS_KEYWORDS = new Set([
	"from",
	"to",
	"and",
	"or",
	"not",
	"only",
	"important",
	"inherit",
	"initial",
	"unset",
	"none",
	"auto",
	"solid",
	"flex",
	"grid",
	"block",
	"inline",
	"absolute",
	"relative",
	"fixed",
	"hidden",
	"scroll",
]);

export function tokenizeSourceLine(
	text: string,
	language: SourceLanguage,
): SourceToken[] {
	if (language === "markdown") return tokenizeMarkdown(text);
	if (language === "python") return tokenizeGeneric(text, PYTHON_KEYWORDS, "#");
	if (language === "json") return tokenizeGeneric(text, JSON_KEYWORDS);
	if (language === "css") return tokenizeGeneric(text, CSS_KEYWORDS);
	if (language === "html") return tokenizeHtml(text);
	if (language === "shell") {
		return tokenizeGeneric(text, SHELL_KEYWORDS, "#", false, SHELL_COMMANDS);
	}
	if (language === "yaml") return tokenizeGeneric(text, JSON_KEYWORDS, "#");
	if (language === "rust") return tokenizeGeneric(text, RUST_KEYWORDS);
	if (language === "go") return tokenizeGeneric(text, GO_KEYWORDS);
	if (language === "plain") return tokenizeGeneric(text, new Set());
	return tokenizeJavascript(text);
}

function tokenizeJavascript(text: string): SourceToken[] {
	return tokenizeGeneric(text, JAVASCRIPT_KEYWORDS, null, true);
}

function tokenizeGeneric(
	text: string,
	keywords: ReadonlySet<string>,
	hashComment: "#" | null = null,
	jsx = false,
	commands: ReadonlySet<string> = new Set(),
): SourceToken[] {
	const tokens: SourceToken[] = [];
	let index = 0;
	let afterOpenTag = false;
	while (index < text.length) {
		const rest = text.slice(index);
		if (hashComment && rest.startsWith(hashComment)) {
			tokens.push({ kind: "comment", text: rest });
			break;
		}
		if (rest.startsWith("//")) {
			tokens.push({ kind: "comment", text: rest });
			break;
		}
		if (rest.startsWith("/*")) {
			const end = rest.indexOf("*/", 2);
			const body = end === -1 ? rest : rest.slice(0, end + 2);
			tokens.push({ kind: "comment", text: body });
			index += body.length;
			continue;
		}
		const quote = rest[0];
		if (quote === '"' || quote === "'" || quote === "`") {
			const body = readQuoted(rest, quote);
			tokens.push({ kind: "string", text: body });
			index += body.length;
			afterOpenTag = false;
			continue;
		}
		const hex = rest.match(/^#(?:[\da-fA-F]{3,8})\b/);
		if (hex?.[0]) {
			tokens.push({ kind: "number", text: hex[0] });
			index += hex[0].length;
			afterOpenTag = false;
			continue;
		}
		if (rest[0] === "@" && /^@[A-Za-z_]/.test(rest)) {
			const decorator = rest.match(/^@[A-Za-z_]\w*/)?.[0] ?? "@";
			tokens.push({ kind: "class", text: decorator });
			index += decorator.length;
			afterOpenTag = false;
			continue;
		}
		if (jsx && rest[0] === "<") {
			tokens.push({ kind: "sign", text: "<" });
			index += 1;
			afterOpenTag = true;
			continue;
		}
		if (rest[0] === "/" && afterOpenTag) {
			tokens.push({ kind: "sign", text: "/" });
			index += 1;
			continue;
		}
		const ident = rest.match(/^[A-Za-z_$][\w$]*/);
		if (ident?.[0]) {
			const word = ident[0];
			const next = rest.slice(word.length);
			tokens.push({
				kind: tokenKindForWord(word, keywords, afterOpenTag, next, commands),
				text: word,
			});
			index += word.length;
			afterOpenTag = false;
			continue;
		}
		const number = readSourceNumber(rest);
		if (number) {
			tokens.push({ kind: "number", text: number });
			index += number.length;
			afterOpenTag = false;
			continue;
		}
		const space = rest.match(/^\s+/);
		if (space?.[0]) {
			tokens.push({ kind: "identifier", text: space[0] });
			index += space[0].length;
			continue;
		}
		const signs = rest.match(/^[^\w\s"'`/$]+/) ?? rest.match(/^\/+/);
		const chunk = signs?.[0] ?? rest[0] ?? "";
		tokens.push({ kind: "sign", text: chunk });
		index += chunk.length;
		if (chunk !== "/") afterOpenTag = false;
	}
	return tokens;
}

function tokenizeHtml(text: string): SourceToken[] {
	return tokenizeGeneric(text, new Set(), null, true);
}

function tokenizeMarkdown(text: string): SourceToken[] {
	const heading = text.match(/^(#{1,6})(\s+)(.*)$/);
	if (heading?.[1] && heading[2] != null && heading[3] != null) {
		return [
			{ kind: "keyword", text: heading[1] },
			{ kind: "identifier", text: heading[2] },
			{ kind: "class", text: heading[3] },
		];
	}
	return tokenizeGeneric(text, new Set());
}

function tokenKindForWord(
	word: string,
	keywords: ReadonlySet<string>,
	afterOpenTag: boolean,
	next: string,
	commands: ReadonlySet<string>,
): SourceTokenKind {
	if (afterOpenTag) return "entity";
	if (keywords.has(word)) return "keyword";
	if (commands.has(word)) return "function";
	if (/^[A-Z][A-Za-z0-9]+$/.test(word)) return "class";
	if (next.startsWith("(")) return "function";
	if (/^(\?|!)?:(?!\/\/)/.test(next)) return "property";
	return "identifier";
}

function readSourceNumber(text: string): string | null {
	const match = text.match(
		/^(0x[\da-fA-F](?:_?[\da-fA-F])*|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:e[+-]?\d(?:_?\d)*)?)(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr)?/i,
	);
	return match?.[0] ?? null;
}

function readQuoted(text: string, quote: string): string {
	let index = 1;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === quote) return text.slice(0, index + 1);
		index += 1;
	}
	return text;
}
