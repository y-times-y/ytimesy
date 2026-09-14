import type { SourceLanguage } from "./source-language";

export type SourceTokenKind =
	| "identifier"
	| "keyword"
	| "string"
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

export function tokenizeSourceLine(
	text: string,
	language: SourceLanguage,
): SourceToken[] {
	if (language === "plain" || language === "markdown") {
		return tokenizeGeneric(text, new Set());
	}
	if (language === "python") return tokenizeGeneric(text, PYTHON_KEYWORDS, "#");
	if (language === "json") return tokenizeGeneric(text, JSON_KEYWORDS);
	if (language === "css") return tokenizeCss(text);
	if (language === "html") return tokenizeHtml(text);
	if (language === "shell") return tokenizeGeneric(text, new Set(), "#");
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
			tokens.push({
				kind: tokenKindForWord(word, keywords, afterOpenTag),
				text: word,
			});
			index += word.length;
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

function tokenizeCss(text: string): SourceToken[] {
	return tokenizeGeneric(text, new Set(["from", "to", "and", "or", "not"]));
}

function tokenizeHtml(text: string): SourceToken[] {
	return tokenizeGeneric(text, new Set(), null, true);
}

function tokenKindForWord(
	word: string,
	keywords: ReadonlySet<string>,
	afterOpenTag: boolean,
): SourceTokenKind {
	if (afterOpenTag) return "entity";
	if (keywords.has(word)) return "keyword";
	if (/^[A-Z][A-Za-z0-9]+$/.test(word)) return "class";
	return "identifier";
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
