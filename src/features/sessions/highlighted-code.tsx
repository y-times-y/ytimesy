import type { SourceLanguage } from "#/domain/source-language";
import { tokenizeSourceLine } from "#/domain/source-tokens";

export function HighlightedCode({
	text,
	language,
}: {
	text: string;
	language: SourceLanguage;
}) {
	const lines = numbered(text.split("\n"), (line) => line);
	return (
		<>
			{lines.map(({ item: line, key }, position) => (
				<span key={key} className="code-line">
					{position > 0 ? "\n" : null}
					<CodeTokens text={line} language={language} />
				</span>
			))}
		</>
	);
}

export function CodeTokens({
	text,
	language,
}: {
	text: string;
	language: SourceLanguage;
}) {
	return numbered(
		tokenizeSourceLine(text, language),
		(token) => `${token.kind}:${token.text}`,
	).map(({ item: token, key }) => (
		<span key={key} className={`code-token code-token-${token.kind}`}>
			{token.text}
		</span>
	));
}

function numbered<T>(
	items: readonly T[],
	identity: (item: T) => string,
): { item: T; key: string }[] {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const base = identity(item);
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return { item, key: `${base}:${count}` };
	});
}
