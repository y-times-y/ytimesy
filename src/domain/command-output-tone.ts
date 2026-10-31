import { unwrapShellCommand } from "./visible-shell-command";

/**
 * Colour roles for plain command output, drawn from the code theme: bad is
 * rose-coral, warn sunflower, good lime, path sky-blue, accent peach, muted
 * gray, match a highlighted search hit, added/removed the diff colours.
 */
export type OutputTone =
	| "bad"
	| "warn"
	| "good"
	| "path"
	| "accent"
	| "muted"
	| "strong"
	| "match"
	| "added"
	| "removed";

export type TonedSpan = { readonly text: string; readonly tone?: OutputTone };

/** One output line: an optional tone for the whole line, then its spans. */
export type TonedLine = {
	readonly tone?: OutputTone;
	readonly spans: readonly TonedSpan[];
};

/** The first lines classified; anything past the cap is `rest`, plain. */
export type TonedOutput = {
	readonly lines: readonly TonedLine[];
	readonly rest: string;
};

const MAX_TONED_LINES = 2000;
const MAX_TONED_LINE_LENGTH = 2000;

type Mark = readonly [start: number, end: number, tone: OutputTone];
type LineToning = { tone?: OutputTone; marks: Mark[] };
/** A family's reading of one line, or null to leave it to the generic rules. */
type LineClassifier = (
	lines: readonly string[],
	index: number,
) => LineToning | null;

/**
 * Plain command output split into coloured lines: search hits, test results,
 * compiler errors, listings and git status each get their own reading, and
 * anything else only marks errors, warnings, successes and URLs. Output that
 * already carries ANSI colours keeps them, mapped to the palette.
 */
export function commandOutputTones(
	command: string,
	output: string,
	maxLines = MAX_TONED_LINES,
): TonedOutput {
	const all = output.split("\n");
	const shown = all.slice(0, maxLines);
	const rest =
		all.length > maxLines ? stripAnsi(all.slice(maxLines).join("\n")) : "";
	if (ANSI_COLOUR.test(output)) return { lines: ansiLines(shown), rest };
	const lines = shown.map((line) => stripAnsi(lastRedraw(line)));
	const classify = familyClassifier(outputFamily(command));
	return {
		lines: lines.map((text, index) => {
			if (text.length > MAX_TONED_LINE_LENGTH) return { spans: [{ text }] };
			const toning = classify(lines, index) ?? genericToning(text);
			return {
				tone: toning.tone,
				spans: spansOf(text, [...toning.marks, ...urlMarks(text)]),
			};
		}),
		rest,
	};
}

// ---------------------------------------------------------------- spans

function spansOf(text: string, marks: readonly Mark[]): TonedSpan[] {
	const spans: TonedSpan[] = [];
	let at = 0;
	const ordered = [...marks].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	for (const [start, end, tone] of ordered) {
		if (start < at || end <= start) continue;
		if (start > at) spans.push({ text: text.slice(at, start) });
		spans.push({ text: text.slice(start, end), tone });
		at = end;
	}
	if (at < text.length || !spans.length) spans.push({ text: text.slice(at) });
	return spans;
}

function regexMarks(text: string, pattern: RegExp, tone: OutputTone): Mark[] {
	const marks: Mark[] = [];
	for (const match of text.matchAll(pattern))
		if (match[0])
			marks.push([match.index, match.index + match[0].length, tone]);
	return marks;
}

const URL = /\bhttps?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;
const urlMarks = (text: string) =>
	text.includes("://") ? regexMarks(text, URL, "path") : [];

const FILE_EXTENSION =
	"(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|vue|svelte|astro|css|scss|less|json|jsonc|ya?ml|toml|md|mdx|html?|sh|sql|lua|exs?|zig|dart|scala|prisma|graphql|proto)";
/** A source file path, optionally with :line:col or (line,col) after it. */
const LOCATION = new RegExp(
	`(?<![\\w@/.:-])(?:[\\w@.+-]*\\/)*[\\w@+-][\\w@.+-]*\\.${FILE_EXTENSION}(?:(?::\\d+){1,2}|\\(\\d+,\\d+\\))?(?![\\w/])`,
	"g",
);
const locationMarks = (text: string) => regexMarks(text, LOCATION, "path");

const DURATION = /\(?\b\d+(?:\.\d+)?\s?(?:ms|s|m)\b\)?/g;

// ---------------------------------------------------------------- ANSI

const ESC = "\\u001b";
const BEL = "\\u0007";
/** CSI sequences, OSC sequences (hyperlinks, titles), charset and keypad modes. */
const ANSI_ESCAPE = new RegExp(
	`${ESC}\\[[\\d;:?]*[A-Za-z]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[()]\\w|${ESC}[=>78]`,
	"g",
);
/** An SGR sequence that sets a foreground colour. */
const ANSI_COLOUR = new RegExp(
	`${ESC}\\[(?:[\\d;]*;)?(?:3[0-8]|9[0-7])(?:;[\\d;]*)?m`,
);
const ANSI_SGR = new RegExp(`${ESC}\\[([\\d;]*)m`, "g");

const stripAnsi = (text: string) => text.replace(ANSI_ESCAPE, "");

/** What a terminal shows of a line redrawn with \r: the last redraw. */
function lastRedraw(line: string) {
	const text = line.replace(/\r+$/, "");
	return text.slice(text.lastIndexOf("\r") + 1);
}

/** The 8 standard colours (black, red, green, yellow, blue, magenta, cyan, white). */
const ANSI_TONES: readonly (OutputTone | undefined)[] = [
	"muted",
	"bad",
	"good",
	"warn",
	"path",
	"accent",
	"path",
	undefined,
];

type AnsiState = { colour?: OutputTone; bold: boolean; dim: boolean };

const ansiTone = (state: AnsiState): OutputTone | undefined =>
	state.colour ?? (state.dim ? "muted" : state.bold ? "strong" : undefined);

function applySgr(state: AnsiState, params: string) {
	const codes = (params || "0").split(";").map((code) => Number(code || 0));
	for (let index = 0; index < codes.length; index++) {
		const code = codes[index] as number;
		if (code === 0) {
			state.colour = undefined;
			state.bold = false;
			state.dim = false;
		} else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 22) state.bold = state.dim = false;
		else if (code === 39) state.colour = undefined;
		else if (code >= 30 && code <= 37) state.colour = ANSI_TONES[code - 30];
		else if (code >= 90 && code <= 97)
			state.colour = code === 97 ? "strong" : ANSI_TONES[code - 90];
		else if (code === 38 || code === 48) {
			const mode = codes[index + 1];
			if (mode === 5) {
				const colour = codes[index + 2] ?? -1;
				if (code === 38)
					state.colour =
						colour >= 0 && colour < 16 ? ANSI_TONES[colour % 8] : undefined;
				index += 2;
			} else if (mode === 2) {
				if (code === 38) state.colour = undefined;
				index += 4;
			}
		}
	}
}

/** Lines coloured by their own ANSI escapes, the state carried across lines. */
function ansiLines(lines: readonly string[]): TonedLine[] {
	const state: AnsiState = { bold: false, dim: false };
	return lines.map((raw) => {
		const spans: TonedSpan[] = [];
		const text = lastRedraw(raw);
		let at = 0;
		const push = (part: string) => {
			const clean = stripAnsi(part);
			if (clean) spans.push({ text: clean, tone: ansiTone(state) });
		};
		for (const match of text.matchAll(ANSI_SGR)) {
			push(text.slice(at, match.index));
			applySgr(state, match[1] ?? "");
			at = match.index + match[0].length;
		}
		push(text.slice(at));
		return { spans: spans.length ? spans : [{ text: "" }] };
	});
}

// ---------------------------------------------------------------- generic

/** The text with its URLs blanked, so words inside them are not read. */
const withoutUrls = (text: string) =>
	text.includes("://")
		? text.replace(URL, (url) => " ".repeat(url.length))
		: text;

// A word, not part of a path, file name or identifier (src/error-boundary.tsx,
// errors.ts, on_error), and not a zero count ("0 errors", "errors: 0").
const word = (words: string) =>
	new RegExp(
		`(?<![\\w/.\\-])(?<!\\b(?:0|no|zero|without)\\s+)(?:${words})(?![\\w/\\-]|\\.\\w)(?!:?\\s*0\\b)`,
		"i",
	);
const BAD_WORDS = word(
	"errors?|failed|failures?|fatal|exception|traceback|panicked|segmentation fault|permission denied|no such file or directory|command not found",
);
const EXCEPTION_NAME = /(?<![\w/.-])[A-Z]\w*(?:Error|Exception)\b(?![\w/.-])/;
const NPM_ERROR = /\b(?:npm|yarn|pnpm) ERR!/;
const WARN_WORDS = word("warn(?:ings?)?|deprecated|deprecation");
const GOOD_WORDS = word(
	"success(?:ful(?:ly)?)?|succeeded|done|passed|passing|completed",
);

export function genericTone(text: string): OutputTone | undefined {
	const words = withoutUrls(text);
	if (
		BAD_WORDS.test(words) ||
		EXCEPTION_NAME.test(words) ||
		NPM_ERROR.test(words)
	)
		return "bad";
	if (WARN_WORDS.test(words)) return "warn";
	if (GOOD_WORDS.test(words) || /[✓✔]/.test(words)) return "good";
	return undefined;
}

const genericToning = (text: string): LineToning => ({
	tone: genericTone(text),
	marks: [],
});

// ---------------------------------------------------------------- command

type SearchTerm = { readonly text: string; readonly caseless: boolean };

type OutputFamily =
	| {
			kind: "search";
			term: SearchTerm | null;
			/** -l, --files, -c: every line is a path. */
			listsFiles: boolean;
	  }
	| { kind: "test" }
	| { kind: "build" }
	| { kind: "listing"; tool: "ls" | "tree" | "find" }
	| { kind: "git"; subcommand: string }
	| { kind: "generic" };

/**
 * Shell words per simple command, quotes removed: `a 'b c' | d && e` is
 * [[a, "b c"], [d], [e]]. Redirections are dropped.
 */
export function shellSegments(command: string): string[][] {
	const segments: string[][] = [[]];
	let word: string | null = null;
	const end = () => {
		if (word !== null) (segments[segments.length - 1] as string[]).push(word);
		word = null;
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index] as string;
		if (char === "'") {
			const close = command.indexOf("'", index + 1);
			const stop = close === -1 ? command.length : close;
			word = (word ?? "") + command.slice(index + 1, stop);
			index = stop;
		} else if (char === '"') {
			let quoted = "";
			for (index++; index < command.length && command[index] !== '"'; index++) {
				const inner = command[index] as string;
				const next = command[index + 1] ?? "";
				if (inner === "\\" && /["\\$`]/.test(next)) {
					quoted += next;
					index++;
				} else quoted += inner;
			}
			word = (word ?? "") + quoted;
		} else if (char === "\\") {
			word = (word ?? "") + (command[index + 1] ?? "");
			index++;
		} else if (char === "&" && /[<>]$/.test(word ?? "")) {
			word = `${word}${char}`;
		} else if (/[|&;\n()]/.test(char)) {
			end();
			if (segments[segments.length - 1]?.length) segments.push([]);
		} else if (/\s/.test(char)) end();
		else word = (word ?? "") + char;
	}
	end();
	return segments
		.map((words) => {
			const kept: string[] = [];
			for (let index = 0; index < words.length; index++) {
				const current = words[index] as string;
				if (/^\d*(?:[<>]{1,2}|&>)&?\d*$/.test(current)) index++;
				else if (!/^\d*(?:[<>]{1,2}|&>)/.test(current)) kept.push(current);
			}
			return kept;
		})
		.filter((words) => words.length);
}

const PREFIX_COMMANDS = new Set([
	"env",
	"time",
	"sudo",
	"nice",
	"command",
	"exec",
	"nohup",
]);
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);

/** The program and its arguments, without env assignments and runners. */
function programWords(words: readonly string[]): string[] {
	let rest = [...words];
	for (;;) {
		const [first = "", second = ""] = rest;
		if (/^\w+=/.test(first) || PREFIX_COMMANDS.has(first)) rest = rest.slice(1);
		else if (first === "timeout") rest = rest.slice(2);
		else if (RUNNERS.has(first)) {
			rest = rest.slice(1);
			while (rest[0]?.startsWith("-")) rest = rest.slice(1);
		} else if (/^(?:pnpm|yarn)$/.test(first) && /^(?:exec|dlx)$/.test(second))
			rest = rest.slice(2);
		else if (/^(?:uv|poetry|pipenv)$/.test(first) && second === "run")
			rest = rest.slice(2);
		else if (/^python[\d.]*$/.test(first) && second === "-m")
			rest = rest.slice(2);
		else break;
	}
	const [program = "", ...args] = rest;
	return [program.replace(/^.*\//, ""), ...args];
}

const TEST_PROGRAMS = new Set([
	"vitest",
	"jest",
	"pytest",
	"py.test",
	"mocha",
	"ava",
	"tap",
]);
const BUILD_PROGRAMS = new Set([
	"tsc",
	"eslint",
	"biome",
	"oxlint",
	"ruff",
	"mypy",
	"pyright",
	"flake8",
	"pylint",
	"prettier",
	"rustc",
	"gcc",
	"g++",
	"clang",
	"clang++",
	"javac",
	"swiftc",
	"vite",
	"next",
	"webpack",
	"esbuild",
	"rollup",
	"tsup",
	"turbo",
	"make",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const BUILD_SCRIPT =
	/^(?:build|lint|typecheck|type-check|types|tsc|check|compile|format)\b/;

/** git's own options before the subcommand: `git -C dir --no-pager log`. */
function withoutGitOptions(args: readonly string[]): string[] {
	let rest = [...args];
	while (rest[0]?.startsWith("-"))
		rest = rest.slice(
			/^-[Cc]$|^--(?:git-dir|work-tree)$/.test(rest[0]) ? 2 : 1,
		);
	return rest;
}

function familyOf(words: readonly string[]): OutputFamily | null {
	const [program = "", ...programArgs] = programWords(words);
	const args = program === "git" ? withoutGitOptions(programArgs) : programArgs;
	const positional = args.filter((arg) => !arg.startsWith("-"));
	const [sub = ""] = positional;
	if (/^(?:rg|grep|egrep|fgrep|ag|ack)$/.test(program))
		return searchFamily(program, args);
	if (program === "git" && sub === "grep")
		return searchFamily("git-grep", args.slice(args.indexOf("grep") + 1));
	if (
		program === "git" &&
		/^(?:status|log|branch|show|diff|shortlog|reflog)$/.test(sub)
	)
		return { kind: "git", subcommand: sub };
	if (TEST_PROGRAMS.has(program)) return { kind: "test" };
	if (
		/^(?:go|cargo|deno|bun|playwright|dotnet|swift|mix|zig)$/.test(program) &&
		/^(?:test|nextest)$/.test(sub)
	)
		return { kind: "test" };
	if (PACKAGE_MANAGERS.has(program)) {
		const script =
			sub === "run" || sub === "run-script" ? (positional[1] ?? "") : sub;
		if (/^(?:t|test)$/.test(sub) || /test/.test(script))
			return { kind: "test" };
		if (BUILD_SCRIPT.test(script)) return { kind: "build" };
	}
	if (program === "make" && /test/.test(sub)) return { kind: "test" };
	if (BUILD_PROGRAMS.has(program)) return { kind: "build" };
	if (
		/^(?:cargo|go|swift|dotnet|gradle|gradlew|mvn)$/.test(program) &&
		/^(?:build|check|clippy|vet|run|compile|install)$/.test(sub)
	)
		return { kind: "build" };
	if (/^(?:ls|ll|la|exa|eza|lsd)$/.test(program))
		return { kind: "listing", tool: "ls" };
	if (program === "tree") return { kind: "listing", tool: "tree" };
	if (/^(?:find|fd|fdfind)$/.test(program))
		return { kind: "listing", tool: "find" };
	return null;
}

/** The first command in the line whose output has a reading of its own. */
function outputFamily(command: string): OutputFamily {
	for (const words of shellSegments(unwrapShellCommand(command))) {
		const family = familyOf(words);
		if (family) return family;
	}
	return { kind: "generic" };
}

function familyClassifier(family: OutputFamily): LineClassifier {
	switch (family.kind) {
		case "search":
			return searchClassifier(family.term, family.listsFiles);
		case "test":
			return testLine;
		case "build":
			return buildLine;
		case "listing":
			return family.tool === "ls"
				? lsLine
				: family.tool === "tree"
					? treeLine
					: findLine;
		case "git":
			return gitClassifier(family.subcommand);
		case "generic":
			return () => null;
	}
}

// ---------------------------------------------------------------- search

/** Options that take a value, so the value is not mistaken for the pattern. */
const SEARCH_VALUE_OPTIONS: Record<string, RegExp> = {
	rg: /^(?:-[ABCgtTmMjEdr]|--(?:glob|iglob|type|type-not|max-count|context|before-context|after-context|max-columns|threads|encoding|max-depth|replace|sort|sortr|color|colors|type-add|pre|pre-glob|max-filesize|path-separator|engine))$/,
	grep: /^(?:-[ABCmdD]|--(?:context|before-context|after-context|max-count|include|exclude|exclude-dir|color|colour|label|binary-files|devices|directories))$/,
	"git-grep":
		/^(?:-[ABCm]|--(?:context|before-context|after-context|max-count|max-depth|threads|color))$/,
	ag: /^(?:-[ABCGm]|--(?:context|ignore|file-search-regex|max-count|depth))$/,
	ack: /^(?:-[ABCm]|--(?:context|type|max-count|ignore-dir))$/,
};
const LIST_FILE_FLAGS =
	/^(?:-[lLc]|--files|--files-with-matches|--files-without-match|--count|--count-matches|--name-only)$/;

function searchFamily(program: string, args: readonly string[]): OutputFamily {
	const tool = /^[ef]?grep$/.test(program) ? "grep" : program;
	const valueOption = SEARCH_VALUE_OPTIONS[tool] ?? SEARCH_VALUE_OPTIONS.grep;
	let pattern: string | null = null;
	let fixed = program === "fgrep";
	let caseless = false;
	let smartCase = false;
	let listsFiles = false;
	let patternFromFile = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--") {
			pattern ??= args[index + 1] ?? null;
			break;
		}
		if (arg === "-e" || arg === "--regexp") {
			pattern ??= args[++index] ?? null;
			continue;
		}
		if (arg.startsWith("--regexp=")) {
			pattern ??= arg.slice("--regexp=".length);
			continue;
		}
		if (arg === "-f" || arg === "--file" || arg.startsWith("--file=")) {
			patternFromFile = true;
			if (arg === "-f" || arg === "--file") index++;
			continue;
		}
		if (valueOption?.test(arg)) {
			index++;
			continue;
		}
		if (arg === "--fixed-strings" || arg === "--literal" || arg === "-Q")
			fixed = true;
		else if (arg === "--ignore-case") caseless = true;
		else if (arg === "--smart-case") smartCase = true;
		else if (LIST_FILE_FLAGS.test(arg)) listsFiles = true;
		else if (/^-[a-zA-Z]+$/.test(arg)) {
			const flags = arg.slice(1);
			if (flags.includes("F") && tool !== "ag") fixed = true;
			if (flags.includes("i")) caseless = true;
			if (flags.includes("S") && tool === "rg") smartCase = true;
			if (/[lLc]/.test(flags) && tool !== "rg") listsFiles = true;
			if (/^[lc]$/.test(flags)) listsFiles = true;
		} else if (!arg.startsWith("-") && pattern === null) pattern = arg;
	}
	if (tool === "rg" && args.includes("--files"))
		return { kind: "search", term: null, listsFiles: true };
	const literal =
		pattern === null || patternFromFile ? null : literalPattern(pattern, fixed);
	const term = literal
		? {
				text: literal,
				caseless: caseless || (smartCase && literal === literal.toLowerCase()),
			}
		: null;
	return { kind: "search", term, listsFiles };
}

/** The text a pattern matches when it matches only itself, else null. */
export function literalPattern(pattern: string, fixed: boolean): string | null {
	if (fixed) return pattern.length >= 2 ? pattern : null;
	let text = "";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index] as string;
		if (char === "\\") {
			const next = pattern[index + 1] ?? "";
			if (!next || /[\w\s]/.test(next)) return null;
			text += next;
			index++;
		} else if (/[.^$*+?()[\]{}|]/.test(char)) return null;
		else text += char;
	}
	return text.length >= 2 ? text : null;
}

function termMarks(
	text: string,
	from: number,
	term: SearchTerm | null,
): Mark[] {
	if (!term) return [];
	const marks: Mark[] = [];
	const haystack = term.caseless ? text.toLowerCase() : text;
	const needle = term.caseless ? term.text.toLowerCase() : term.text;
	for (
		let at = haystack.indexOf(needle, from);
		at !== -1 && marks.length < 100;
		at = haystack.indexOf(needle, at + needle.length)
	)
		marks.push([at, at + needle.length, "match"]);
	return marks;
}

const SEARCH_HIT = /^((?:[A-Za-z]:)?[^\s:][^:]*?):(\d+):(?:(\d+):)?/;
const SEARCH_CONTEXT = /^([^\s:][^:]*?)-(\d+)-/;
const NUMBERED_HIT = /^(\d+)([:-])(?:(\d+):)?/;
const PATH_PREFIX = /^((?:\.{0,2}\/)?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)*):/;
const looksLikePath = (text: string) =>
	/^[^\s:]+$/.test(text) && (text.includes("/") || /\.\w+$/.test(text));

function searchClassifier(
	term: SearchTerm | null,
	listsFiles: boolean,
): LineClassifier {
	return (lines, index) => {
		const text = lines[index] as string;
		if (text === "--") return { tone: "muted", marks: [] };
		if (listsFiles) {
			const count = text.match(/^(.+):(\d+)$/);
			if (count)
				return {
					marks: [
						[0, (count[1] as string).length, "path"],
						[(count[1] as string).length, text.length, "muted"],
					],
				};
			return looksLikePath(text) ? { tone: "path", marks: [] } : null;
		}
		const hit = text.match(SEARCH_HIT);
		if (hit && /\D/.test(hit[1] as string)) {
			const path = (hit[1] as string).length;
			return {
				marks: [
					[0, path, "path"],
					[path, hit[0].length, "muted"],
					...termMarks(text, hit[0].length, term),
				],
			};
		}
		const context = text.match(SEARCH_CONTEXT);
		if (context && looksLikePath(context[1] as string)) {
			const path = (context[1] as string).length;
			return {
				tone: "muted",
				marks: [[0, path, "path"], ...termMarks(text, context[0].length, term)],
			};
		}
		const numbered = text.match(NUMBERED_HIT);
		if (numbered)
			return {
				tone: numbered[2] === "-" ? "muted" : undefined,
				marks: [
					[0, numbered[0].length, "muted"],
					...termMarks(text, numbered[0].length, term),
				],
			};
		const next = lines[index + 1] ?? "";
		if (looksLikePath(text) && NUMBERED_HIT.test(next))
			return { tone: "path", marks: [] };
		const prefixed = text.match(PATH_PREFIX);
		if (prefixed && looksLikePath(prefixed[1] as string))
			return {
				marks: [
					[0, (prefixed[1] as string).length, "path"],
					...termMarks(text, prefixed[0].length, term),
				],
			};
		const matches = termMarks(text, 0, term);
		return matches.length ? { marks: matches } : null;
	};
}

// ---------------------------------------------------------------- counts

const COUNT =
	/\b(\d+)\s+(passed|passing|xpassed|failed|failing|failures?|errors?|problems?|skipped|skips?|todo|pending|ignored|deselected|xfailed|warnings?|insertions?\(\+\)|deletions?\(-\))(?![\w-])/gi;

function countTone(count: number, word: string): OutputTone {
	const name = word.toLowerCase();
	if (/^(?:passed|passing|xpassed)$/.test(name))
		return count ? "good" : "muted";
	if (/^(?:skipped|skips?|todo|pending|ignored|deselected|xfailed)$/.test(name))
		return "muted";
	if (count === 0) return "muted";
	if (name.startsWith("warning")) return "warn";
	if (name.startsWith("insertion")) return "added";
	if (name.startsWith("deletion")) return "removed";
	return "bad";
}

/** Outcome counts ("3 passed", "1 failed", "2 warnings") coloured by outcome. */
function countMarks(text: string): Mark[] {
	const marks: Mark[] = [];
	for (const match of text.matchAll(COUNT))
		marks.push([
			match.index,
			match.index + match[0].length,
			countTone(Number(match[1]), match[2] as string),
		]);
	return marks;
}

// ---------------------------------------------------------------- tests

const TEST_FAIL =
	/^\s*(?:FAIL\b|FAILED\b|not ok\b|✗|✘|×|✕|●|--- FAIL\b|ERROR\b|E {2,}|panicked\b)|\bpanicked at\b|^thread '.*' panicked|\s(?:FAILED|ERROR)(?:\s+\[[\s\d%]+\])?$/;
const TEST_SKIP =
	/^\s*(?:↓|○|--- SKIP\b|SKIP(?:PED)?\b)|\[skipped\]|\s(?:SKIPPED|ignored|XFAIL)(?:\s+\[[\s\d%]+\])?$/;
const TEST_PASS =
	/^\s*(?:PASS\b|PASSED\b|ok\b|✓|✔|√|--- PASS\b)|\s(?:PASSED|ok)(?:\s+\[[\s\d%]+\])?$/;
const TEST_CHATTER = /^\s*(?:=== RUN\b|RUN\b|Duration\b|Start at\b|Running\b)/;

function testLine(lines: readonly string[], index: number): LineToning | null {
	const text = lines[index] as string;
	const counts = countMarks(text);
	if (counts.length)
		return {
			marks: [
				...counts,
				...regexMarks(text, /\b(?:FAILED|FAIL)\b/g, "bad"),
				...regexMarks(text, /(?<=test result: )ok\b/g, "good"),
				...locationMarks(text),
			],
		};
	const details = [
		...locationMarks(text),
		...regexMarks(text, DURATION, "muted"),
	];
	if (TEST_FAIL.test(text)) return { tone: "bad", marks: details };
	if (TEST_SKIP.test(text)) return { tone: "muted", marks: [] };
	if (TEST_PASS.test(text)) return { tone: "good", marks: details };
	if (TEST_CHATTER.test(text)) return { tone: "muted", marks: [] };
	if (details.length)
		return {
			tone: genericTone(text),
			marks: [...regexMarks(text, /\[\s*\d+%\]/g, "muted"), ...details],
		};
	return null;
}

// ---------------------------------------------------------------- build

const BUILD_HEADLINE =
	/^\s*(?:error|warning|warn)(?:\[[\w-]+\])?(?::|\s+TS\d+)/i;
const BUILD_KEYWORD =
	/(?<![\w/.-])(?:error|warning)(?:\s+TS\d+|\[[\w-]+\])?(?![\w/-])/i;
const ESLINT_ROW = /^(\s+)(\d+:\d+)(\s+)(error|warning)(\s+.*?\s{2,})(\S+)$/;
const RUST_GUTTER = /^\s*\d*\s*\|/;

function buildLine(lines: readonly string[], index: number): LineToning | null {
	const text = lines[index] as string;
	const locations = locationMarks(text);
	const headline = text.match(BUILD_HEADLINE);
	if (headline)
		return {
			tone: /^\s*warn/i.test(headline[0]) ? "warn" : "bad",
			marks: locations,
		};
	if (NPM_ERROR.test(text)) return { tone: "bad", marks: [] };
	const eslint = text.match(ESLINT_ROW);
	if (eslint) {
		const [
			,
			indent = "",
			position = "",
			gap = "",
			level = "",
			message = "",
			rule = "",
		] = eslint;
		const at = indent.length;
		const levelAt = at + position.length + gap.length;
		const ruleAt = levelAt + level.length + message.length;
		return {
			marks: [
				[at, at + position.length, "muted"],
				[levelAt, levelAt + level.length, level === "error" ? "bad" : "warn"],
				[ruleAt, ruleAt + rule.length, "muted"],
			],
		};
	}
	const counts = countMarks(text);
	if (/^\s*[✖×]\s*\d+ problems?/.test(text))
		return { tone: "bad", marks: counts };
	if (counts.length) return { marks: [...counts, ...locations] };
	if (/^\s*-->\s/.test(text))
		return { marks: [[0, text.indexOf("-->") + 3, "muted"], ...locations] };
	if (RUST_GUTTER.test(text)) {
		const gutter = (text.match(RUST_GUTTER) as RegExpMatchArray)[0].length;
		return {
			marks: [[0, gutter, "muted"], ...regexMarks(text, /\^+|-{3,}/g, "bad")],
		};
	}
	if (/^\s*[×✖✗]\s/.test(text)) return { tone: "bad", marks: locations };
	if (/^\s*!\s/.test(text)) return { tone: "warn", marks: locations };
	if (/^\s*(?:=\s*)?(?:note|help):/.test(text))
		return { tone: "muted", marks: locations };
	if (locations.length) {
		const keyword = text.match(BUILD_KEYWORD);
		if (keyword?.index === undefined)
			return { tone: genericTone(text), marks: locations };
		const end = keyword.index + keyword[0].length;
		return {
			marks: [
				...locations,
				[keyword.index, end, /^warn/i.test(keyword[0]) ? "warn" : "bad"],
			],
		};
	}
	const trimmed = text.trim();
	return looksLikePath(trimmed) &&
		trimmed.includes("/") &&
		/\.\w+$/.test(trimmed)
		? { tone: "path", marks: [] }
		: null;
}

// ---------------------------------------------------------------- listings

const LS_LONG =
	/^([-dlcbpsD])([rwxsStT-]{9})[@+.]?\s+\d+\s+\S+\s+\S+\s+(?:\d+,\s*)?[\d.,]+[KMGTPB]?\s+(?:\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})|\d{1,2}\s+\w{3}\s+(?:\d{1,2}:\d{2}|\d{4})|\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s+[+-]\d{4})?)?)\s+/;

type EntryKind = "dir" | "link" | "exec" | "dot" | "file";
const ENTRY_TONES: Record<EntryKind, OutputTone | undefined> = {
	dot: "muted",
	dir: "path",
	link: "accent",
	exec: "good",
	file: undefined,
};

function entryMarks(text: string, start: number, kind: EntryKind): Mark[] {
	const arrow = text.indexOf(" -> ", start);
	const nameEnd = kind === "link" && arrow !== -1 ? arrow : text.length;
	const tone = ENTRY_TONES[kind];
	const marks: Mark[] = tone ? [[start, nameEnd, tone]] : [];
	if (nameEnd < text.length) marks.push([nameEnd, text.length, "muted"]);
	return marks;
}

const isDotName = (name: string) =>
	/^\.(?!\/?$)/.test(name) || name === "." || name === "..";

/** An entry by its ls -F / tree -F marker (/ * @), else a dotfile or plain file. */
function markedKind(name: string): EntryKind {
	if (isDotName(name)) return "dot";
	if (name.endsWith("/")) return "dir";
	if (name.endsWith("*")) return "exec";
	if (name.endsWith("@") || name.includes(" -> ")) return "link";
	return "file";
}

function lsLine(lines: readonly string[], index: number): LineToning | null {
	const text = lines[index] as string;
	if (/^total \d+/.test(text)) return { tone: "muted", marks: [] };
	const long = text.match(LS_LONG);
	if (long) {
		const name = text.slice(long[0].length);
		const type = long[1];
		const kind: EntryKind = isDotName(name)
			? "dot"
			: type === "d"
				? "dir"
				: type === "l"
					? "link"
					: /x/.test(long[2] as string)
						? "exec"
						: "file";
		return {
			marks: [
				[0, long[0].length, "muted"],
				...entryMarks(text, long[0].length, kind),
			],
		};
	}
	if (/^\S.*:$/.test(text) && !/\s{2}/.test(text))
		return { tone: "path", marks: [] };
	if (/^(?:ls|exa|eza):/.test(text)) return null;
	const marks: Mark[] = [];
	for (const match of text.matchAll(/\S+/g)) {
		const tone = ENTRY_TONES[markedKind(match[0])];
		if (tone) marks.push([match.index, match.index + match[0].length, tone]);
	}
	return { marks };
}

const TREE_PREFIX = /^((?:[│|]\s{2,3}|\s{4})*(?:[├└|`][─-]{2}\s))/;

function treeLine(lines: readonly string[], index: number): LineToning | null {
	const text = lines[index] as string;
	if (/^\d+ director(?:y|ies)(?:, \d+ files?)?$/.test(text))
		return { tone: "muted", marks: [] };
	const prefix = text.match(TREE_PREFIX)?.[0];
	if (!prefix)
		return index === 0 && text.trim() ? { tone: "path", marks: [] } : null;
	const name = text.slice(prefix.length);
	const nextPrefix = (lines[index + 1] ?? "").match(TREE_PREFIX)?.[0];
	let kind = markedKind(name);
	if (kind === "file" && nextPrefix && nextPrefix.length > prefix.length)
		kind = "dir";
	return {
		marks: [
			[0, prefix.length, "muted"],
			...entryMarks(text, prefix.length, kind),
		],
	};
}

function findLine(lines: readonly string[], index: number): LineToning | null {
	const text = lines[index] as string;
	if (!text || /\s{2}|^(?:find|fd):/.test(text)) return null;
	const name = text.replace(/\/$/, "").replace(/^.*\//, "");
	const isDir =
		text.endsWith("/") || (lines[index + 1] ?? "").startsWith(`${text}/`);
	if (isDotName(name) && name !== "." && name !== "..")
		return { tone: "muted", marks: [] };
	if (isDir) return { tone: "path", marks: [] };
	const folder = text.length - name.length;
	return { marks: folder ? [[0, folder, "muted"]] : [] };
}

// ---------------------------------------------------------------- git

const STATUS_SHORT = /^([ MADRCUT?!])([ MADRCUT?!]) (.+)$/;
const STATUS_LONG =
	/^\t(modified|new file|deleted|renamed|copied|typechange|both modified|both added|both deleted|added by us|added by them|deleted by us|deleted by them):\s+/;
const LOG_LINE = /^([*|\\/ _.-]*?)([0-9a-f]{7,40})\b( \([^)]*\))?/;
const COMMIT_LINE = /^([*|\\/ ]*)(commit) ([0-9a-f]{7,40})( \([^)]*\))?/;
const STAT_LINE = /^ (.+?)\s+\|\s+(?:\d+ ?(\+*)(-*)|Bin .*)$/;

function statusCodeTone(code: string): OutputTone | undefined {
	if (code === "??" || code === "!!") return "muted";
	if (
		code.includes("U") ||
		code === "DD" ||
		code === "AA" ||
		code.includes("D")
	)
		return "bad";
	if (code.includes("A")) return "good";
	if (/[MTRC]/.test(code)) return "warn";
	return undefined;
}

function longStatusTone(label: string): OutputTone {
	if (
		label === "new file" ||
		label === "added by us" ||
		label === "added by them"
	)
		return "good";
	if (label.startsWith("both") || label.startsWith("deleted")) return "bad";
	return "warn";
}

function gitClassifier(subcommand: string): LineClassifier {
	let section = "";
	return (lines, index) => {
		const text = lines[index] as string;
		if (index === 0) section = "";
		if (
			/^(?:Changes to be committed|Changes not staged for commit|Untracked files|Unmerged paths|Ignored files):$/.test(
				text,
			)
		) {
			section = text;
			return { tone: "strong", marks: [] };
		}
		const branch = text.match(/^(On branch |HEAD detached (?:at|from) )(\S+)/);
		if (branch) {
			const at = (branch[1] as string).length;
			return { marks: [[at, at + (branch[2] as string).length, "accent"]] };
		}
		if (/^Your branch /.test(text))
			return { marks: regexMarks(text, /'[^']+'/g, "accent") };
		if (
			/^\s+\(use "git .*\)$/.test(text) ||
			/^no changes added to commit/.test(text)
		)
			return { tone: "muted", marks: [] };
		if (/^nothing to commit/.test(text)) return { tone: "good", marks: [] };
		const long = text.match(STATUS_LONG);
		if (long) return { tone: longStatusTone(long[1] as string), marks: [] };
		if (/^\t/.test(text) && /^(?:Untracked|Ignored)/.test(section))
			return { tone: "muted", marks: [] };
		const tracking = text.match(/^## (\S+?)(?:\.\.\.(\S+))?(?: \[.*\])?$/);
		if (tracking) {
			const end =
				3 +
				(tracking[1] as string).length +
				(tracking[2] ? 3 + tracking[2].length : 0);
			return {
				marks: [
					[0, 2, "muted"],
					[3, end, "accent"],
					[end, text.length, "muted"],
				],
			};
		}
		const short = text.match(STATUS_SHORT);
		if (short && subcommand === "status")
			return { tone: statusCodeTone(`${short[1]}${short[2]}`), marks: [] };
		if (subcommand === "branch") {
			const listed = text.match(/^([* +]) (\S+)/);
			if (listed)
				return {
					marks: [
						...(listed[1] === "*" ? [[0, 1, "good"] as Mark] : []),
						[2, 2 + (listed[2] as string).length, "accent"],
						...regexMarks(text, /(?<=\s)[0-9a-f]{7,40}\b/g, "warn"),
					],
				};
		}
		const commit = text.match(COMMIT_LINE);
		if (commit) {
			const graph = (commit[1] as string).length;
			const hashAt = graph + 7;
			const hashEnd = hashAt + (commit[3] as string).length;
			return {
				marks: [
					[0, hashAt, "muted"],
					[hashAt, hashEnd, "warn"],
					[hashEnd, hashEnd + (commit[4]?.length ?? 0), "accent"],
				],
			};
		}
		if (
			/^(?:[*|\\/ ]*)(?:Author|AuthorDate|Commit|CommitDate|Date|Merge):/.test(
				text,
			)
		)
			return { tone: "muted", marks: [] };
		const stat = text.match(STAT_LINE);
		if (stat) {
			const pathEnd = 1 + (stat[1] as string).length;
			const plusAt =
				text.length - (stat[2]?.length ?? 0) - (stat[3]?.length ?? 0);
			const minusAt = plusAt + (stat[2]?.length ?? 0);
			return {
				marks: [
					[1, pathEnd, "path"],
					[plusAt, minusAt, "added"],
					[minusAt, text.length, "removed"],
				],
			};
		}
		if (/^\s*\d+ files? changed/.test(text)) return { marks: countMarks(text) };
		if (/^(?:log|show|reflog)$/.test(subcommand)) {
			const log = text.match(LOG_LINE);
			if (log) {
				const graph = (log[1] as string).length;
				const hashEnd = graph + (log[2] as string).length;
				return {
					marks: [
						[0, graph, "muted"],
						[graph, hashEnd, "warn"],
						[hashEnd, hashEnd + (log[3]?.length ?? 0), "accent"],
					],
				};
			}
		}
		return null;
	};
}
