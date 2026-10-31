import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AppShot } from "./landing-app-shot";

it("server-renders the open edit already coloured, and every chat as a button", () => {
	const html = renderToStaticMarkup(<AppShot />);
	// Ember Dusk's rose-coral keyword colour on `import`, before any script runs.
	expect(html).toMatch(/<span style="color:#FF6F7D[^"]*">import<\/span>/i);
	expect(html).toContain("Edited appearance.tsx");
	expect(html.match(/class="as-row"/g)?.length).toBe(7);
	expect(html).toContain('aria-current="true"');
});
