import { type SourceLanguage, sourceLanguageFromPath } from "./source-language";
import { unwrapShellCommand } from "./visible-shell-command";

/** Commands that print a file as it is (or a slice of it). */
const PRINTERS = new Set(["cat", "head", "tail", "sed", "nl", "bat"]);
/** Commands that only slice what is piped into them. */
const SLICERS = /^(?:head|tail|nl|sed\s+-n)\b/;

/**
 * The language a command's output is written in, when it is plainly one
 * file (`cat src/a.ts`, `sed -n '1,80p' app.py`) or a diff (`git diff`), so
 * the output can be coloured like the file. Anything else is "text".
 */
export function commandOutputLanguage(command: string): SourceLanguage {
	const text = unwrapShellCommand(command);
	if (/[;&\n<>`$]/.test(text)) return "text";
	const [first = "", ...rest] = text.split("|").map((part) => part.trim());
	if (!rest.every((part) => SLICERS.test(part))) return "text";
	if (/^git\s+(?:diff|show)\b/.test(first))
		return /\s--(?:stat|name-only|name-status|shortstat|numstat)\b/.test(first)
			? "text"
			: "diff";
	const words = first.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
	const [program = "", ...args] = words;
	if (!PRINTERS.has(program)) return "text";
	const files = args.filter(
		(arg, index) =>
			!arg.startsWith("-") &&
			!/^['"]/.test(arg) &&
			!/^\d+$/.test(arg) &&
			// `head -n 20 file`: 20 belongs to -n.
			!/^-[nc]$/.test(args[index - 1] ?? ""),
	);
	return files.length === 1
		? sourceLanguageFromPath(files[0] as string)
		: "text";
}
