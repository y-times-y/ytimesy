import { FreestyleApiError } from "freestyle";
import { describe, expect, it, vi } from "vitest";
import {
	type BoxToolIdentities,
	mintBoxToolIdentity,
	revokeBoxToolIdentity,
} from "./box-tool-identity";

/** A Freestyle identities namespace that records what was asked, in order. */
function fakeIdentities(
	options: { grantFails?: boolean; deleteStatus?: number } = {},
) {
	const calls: string[] = [];
	const grant = vi.fn(async (input: unknown) => {
		calls.push(`grant ${JSON.stringify(input)}`);
		if (options.grantFails) throw new Error("grant refused");
		return {};
	});
	const tokens = {
		create: vi.fn(async () => {
			calls.push("token");
			return { id: "tok_1", token: "fs-identity-token" };
		}),
	};
	const identities = {
		create: vi.fn(async () => {
			calls.push("create");
			return {
				identityId: "ident_1",
				identity: { permissions: { vm: { grant } }, tokens },
				data: { id: "ident_1", managed: false },
			};
		}),
		delete: vi.fn(async (id: string) => {
			calls.push(`delete ${id}`);
			if (options.deleteStatus)
				throw new FreestyleApiError(options.deleteStatus, {
					code: "X",
					message: "x",
				} as never);
		}),
	};
	return {
		calls,
		grant,
		identities: identities as unknown as BoxToolIdentities,
	};
}

describe("Claude box tool identities", () => {
	it("records the identity before granting exactly one VM and Linux user, then mints its token", async () => {
		const fake = fakeIdentities();
		const record = vi.fn(async (id: string) => {
			fake.calls.push(`record ${id}`);
			return true;
		});
		const grant = await mintBoxToolIdentity(fake.identities, {
			vmId: "vm-1",
			linuxUser: "ubuntu",
			record,
		});
		expect(grant).toEqual({
			identityId: "ident_1",
			token: "fs-identity-token",
		});
		expect(fake.calls).toEqual([
			"create",
			"record ident_1",
			`grant ${JSON.stringify({ vmId: "vm-1", allowedLinuxUsers: ["ubuntu"] })}`,
			"token",
		]);
	});

	it("grants nothing and deletes the identity when the turn is no longer this step's", async () => {
		const fake = fakeIdentities();
		const grant = await mintBoxToolIdentity(fake.identities, {
			vmId: "vm-1",
			linuxUser: "ubuntu",
			record: async () => false,
		});
		expect(grant).toBeNull();
		expect(fake.grant).not.toHaveBeenCalled();
		expect(fake.calls).toEqual(["create", "delete ident_1"]);
	});

	it("deletes the identity again when the grant fails, and reports the failure", async () => {
		const fake = fakeIdentities({ grantFails: true });
		await expect(
			mintBoxToolIdentity(fake.identities, {
				vmId: "vm-1",
				linuxUser: "ubuntu",
				record: async () => true,
			}),
		).rejects.toThrow("grant refused");
		expect(fake.calls.at(-1)).toBe("delete ident_1");
		expect(fake.calls).not.toContain("token");
	});

	it("treats an identity already gone as revoked and any other failure as a failure", async () => {
		await expect(
			revokeBoxToolIdentity(
				fakeIdentities({ deleteStatus: 404 }).identities,
				"ident_1",
			),
		).resolves.toBeUndefined();
		await expect(
			revokeBoxToolIdentity(
				fakeIdentities({ deleteStatus: 500 }).identities,
				"ident_1",
			),
		).rejects.toBeInstanceOf(FreestyleApiError);
	});
});
