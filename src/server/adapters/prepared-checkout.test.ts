import { beforeEach, expect, it, vi } from "vitest";
import {
	readPreparedCheckoutDirectory,
	readProjectDerivedValue,
	savePreparedCheckoutDirectory,
} from "./prepared-checkout";

const query = vi.fn();
vi.mock("./database", () => ({ database: () => ({ query }) }));
beforeEach(() => query.mockReset());

it("reads the chat's own path first, else its project's latest root chat's", async () => {
	query.mockResolvedValueOnce({ rows: [{ directory: "/home/ubuntu/app" }] });
	expect(await readPreparedCheckoutDirectory("owner", "chat", "project")).toBe(
		"/home/ubuntu/app",
	);
	const [sql, params] = query.mock.calls[0];
	expect(sql).toContain("order by (s.id=$1) desc");
	expect(sql).toContain("s.parent_session_id is null");
	expect(params).toEqual([
		"chat",
		"owner",
		"project",
		"prepared-checkout-directory",
	]);
	// Nothing reported, or something that is not an absolute path.
	query.mockResolvedValueOnce({ rows: [] });
	expect(await readPreparedCheckoutDirectory("owner", "chat", null)).toBeNull();
	query.mockResolvedValueOnce({ rows: [{ directory: "app" }] });
	expect(
		await readPreparedCheckoutDirectory("owner", "chat", "project"),
	).toBeNull();
});

it("records only absolute paths, rewriting the receipt only when it changed", async () => {
	query.mockResolvedValue({ rows: [] });
	await savePreparedCheckoutDirectory("owner", "chat", "relative");
	expect(query).not.toHaveBeenCalled();
	await savePreparedCheckoutDirectory("owner", "chat", "/home/ubuntu/app");
	const [sql, params] = query.mock.calls[0];
	expect(sql).toContain("is distinct from excluded.response");
	expect(JSON.parse(params[3])).toEqual({
		id: "prepared-checkout-directory",
		ok: true,
		result: { directory: "/home/ubuntu/app" },
	});
});

it("reads a derived value only from the same user's root chats in the same project", async () => {
	query.mockResolvedValueOnce({ rows: [{ value: { version: 1, hooks: [] } }] });
	const key = `lifecycle-hooks:/home/ubuntu/app:${"b".repeat(40)}`;
	expect(await readProjectDerivedValue("owner", "project", key)).toEqual({
		version: 1,
		hooks: [],
	});
	const [sql, params] = query.mock.calls[0];
	expect(sql).toContain("s.user_id=$1");
	expect(sql).toContain("s.project_id=$2::uuid");
	expect(sql).toContain("s.parent_session_id is null");
	expect(sql).toContain("r.request_id=$3");
	expect(params).toEqual(["owner", "project", key]);
	query.mockResolvedValueOnce({ rows: [] });
	expect(await readProjectDerivedValue("owner", "project", key)).toBeNull();
});
