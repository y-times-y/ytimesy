import { describe, expect, it } from "vitest";
import {
	importFinishOutcome,
	PENDING_IMPORT_MAX_AGE_MS,
	parsePendingImports,
	withoutPendingImport,
	withPendingImport,
} from "./import-finish-alert";
import type { LocalImportView } from "./local-import-view";

const ID = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000_000;

function view(overrides: Partial<LocalImportView> = {}): LocalImportView {
	return {
		id: ID,
		status: "importing",
		agent: "claude",
		sessionsPlanned: 2,
		sessionsImported: 1,
		projectId: null,
		sessionId: null,
		message: null,
		...overrides,
	};
}

describe("pending imports", () => {
	it("reads only well-formed, fresh markers", () => {
		expect(parsePendingImports(null, NOW)).toEqual([]);
		expect(parsePendingImports("not json", NOW)).toEqual([]);
		expect(parsePendingImports('{"id":"x"}', NOW)).toEqual([]);
		const raw = JSON.stringify([
			{ id: ID, at: NOW - 1000 },
			{ id: OTHER, at: NOW - PENDING_IMPORT_MAX_AGE_MS },
			{ id: "not-a-uuid", at: NOW },
			{ id: OTHER },
		]);
		expect(parsePendingImports(raw, NOW)).toEqual([{ id: ID, at: NOW - 1000 }]);
	});

	it("adds an import once, newest last, and removes it", () => {
		const once = withPendingImport([], ID, NOW);
		const twice = withPendingImport(once, ID, NOW + 5);
		expect(twice).toEqual([{ id: ID, at: NOW + 5 }]);
		const both = withPendingImport(twice, OTHER, NOW + 6);
		expect(both.map((item) => item.id)).toEqual([ID, OTHER]);
		expect(withoutPendingImport(both, ID)).toEqual([
			{ id: OTHER, at: NOW + 6 },
		]);
	});
});

describe("importFinishOutcome", () => {
	it("keeps polling while the import runs", () => {
		for (const status of ["waiting", "connected", "importing"] as const)
			expect(importFinishOutcome(view({ status }))).toEqual({
				kind: "pending",
			});
	});

	it("stops quietly on failure, expiry or cancel", () => {
		for (const status of ["failed", "expired"] as const)
			expect(importFinishOutcome(view({ status }))).toEqual({
				kind: "settled",
			});
	});

	it("announces a ready import with its agent and chat link", () => {
		expect(
			importFinishOutcome(
				view({ status: "ready", projectId: "p1", sessionId: "c1" }),
			),
		).toEqual({
			kind: "ready",
			alert: {
				title: "Imported from Claude Code",
				action: "Open chat",
				href: "/?project=p1&chat=c1",
			},
		});
		const unknown = importFinishOutcome(
			view({ status: "ready", agent: null, projectId: "p1", sessionId: "c1" }),
		);
		expect(unknown.kind === "ready" && unknown.alert.title).toBe(
			"Import ready",
		);
		expect(importFinishOutcome(view({ status: "ready" }))).toEqual({
			kind: "settled",
		});
	});
});
