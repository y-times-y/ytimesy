import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { PublicSubscriptionAccount } from "#/server/adapters/subscription-accounts";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
}));
vi.mock("./subscription-accounts.fn", () => ({
	addClaudeAccountFn: vi.fn(),
	getChatAccountPinFn: vi.fn(),
	getSubscriptionAccounts: vi.fn(),
	pinChatAccountFn: vi.fn(),
	removeSubscriptionAccountFn: vi.fn(),
	renameSubscriptionAccountFn: vi.fn(),
	reorderSubscriptionAccountsFn: vi.fn(),
	startAddChatgptAccountFn: vi.fn(),
}));
vi.mock("./codex-session.fn", () => ({
	pollCodexLogin: vi.fn(),
	startChatgptSignIn: vi.fn(),
}));

import {
	AccountPin,
	SUBSCRIPTION_ACCOUNTS_KEY,
	SubscriptionAccountsSection,
} from "./subscription-accounts";

const account = (
	over: Partial<PublicSubscriptionAccount>,
): PublicSubscriptionAccount => ({
	id: "a",
	provider: "claude",
	label: "Personal",
	email: null,
	planType: null,
	state: "valid",
	message: null,
	limitedUntil: null,
	priority: 0,
	lastUsedAt: null,
	connectedAt: 1,
	windows: [],
	active: true,
	...over,
});

function render(accounts: PublicSubscriptionAccount[], ui = "section") {
	const client = new QueryClient();
	client.setQueryData(SUBSCRIPTION_ACCOUNTS_KEY, accounts);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			{ui === "section" ? (
				<SubscriptionAccountsSection />
			) : (
				<AccountPin provider="claude" sessionId="s1" />
			)}
		</QueryClientProvider>,
	);
}

it("shows nothing for a user without accounts", () => {
	expect(render([])).toBe("");
});

it("lists each account with its status, the one in use, and the add flow", () => {
	const html = render([
		account({ id: "a", label: "Personal", active: true }),
		account({
			id: "b",
			label: "Work",
			active: false,
			priority: 1,
			state: "limited",
			limitedUntil: Date.now() + 3_600_000,
		}),
	]);
	expect(html).toContain("Personal");
	expect(html).toContain("In use");
	expect(html).toContain("Work");
	expect(html).toContain("Limited · resets");
	expect(html).toContain("Ready");
	expect(html).toContain("Add another account");
	expect(html).toContain("Options for Work");
	expect(html).toContain(
		"Use accounts you own; follow each provider&#x27;s terms.",
	);
});

it("never prints a token and masks emails it is given", () => {
	const html = render([
		account({ email: "a•••@example.com", planType: "plus" }),
	]);
	expect(html).toContain("a•••@example.com");
	expect(html).not.toContain("sk-ant");
});

it("the picker pin appears only with two or more accounts of the provider", () => {
	expect(render([account({})], "pin")).toBe("");
	const html = render(
		[account({ id: "a" }), account({ id: "b", label: "Work", active: false })],
		"pin",
	);
	expect(html).toContain("Auto");
	expect(html).toContain("Work");
});

it("shows the provider's usage windows and when they reset", () => {
	const html = render([
		account({
			windows: [
				{ id: "5h", usedPercent: 62, resetsAt: Date.now() + 3_600_000 },
				{ id: "7d", usedPercent: 18, resetsAt: Date.now() + 4 * 86_400_000 },
			],
		}),
		account({ id: "b", label: "Work", active: false }),
	]);
	expect(html).toContain("5 h 62%");
	expect(html).toContain("7 d 18%");
	expect(html).toContain("resets");
});
