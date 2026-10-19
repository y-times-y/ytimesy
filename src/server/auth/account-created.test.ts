import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	record: vi.fn(async (_userId: string, _source: string) => undefined),
	capture: vi.fn(async () => undefined),
}));
vi.mock("../adapters/legal-acceptance", () => ({
	recordLegalAcceptance: mocks.record,
}));
vi.mock("../adapters/analytics", () => ({
	captureServerAnalytics: mocks.capture,
}));
vi.mock("../adapters/database", () => ({ database: () => ({}) }));

import { accountCreated } from "./auth";

it("records Terms and Privacy acceptance for every new account", async () => {
	const createdAt = new Date();
	await accountCreated({ id: "new-user", createdAt });
	expect(mocks.record).toHaveBeenCalledWith("new-user", "signup");
	expect(mocks.capture).toHaveBeenCalledWith(
		"new-user",
		"account_created",
		{},
		{ key: "new-user", timestamp: createdAt },
	);
});

it("does not fail sign-up when the acceptance write fails", async () => {
	mocks.record.mockRejectedValueOnce(new Error("database down"));
	const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
	await expect(
		accountCreated({ id: "u2", createdAt: new Date() }),
	).resolves.toBeUndefined();
	expect(error).toHaveBeenCalled();
	error.mockRestore();
});
