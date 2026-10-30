import { createCodePlugin } from "@streamdown/code";
import { ytimesyCodeTheme } from "./code-theme";

/** The app is dark; the light theme only answers Streamdown's light slot. */
export const codeHighlighter = createCodePlugin({
	themes: ["github-light", ytimesyCodeTheme],
});
