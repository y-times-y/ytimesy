import { Freestyle } from "freestyle";
import type { GuestExec } from "../claude-box-tools/identity-machines";

/**
 * The box's direct VM exec: a Freestyle client holding only the turn's scoped
 * identity token (reaches exec on one VM as one Linux user), as the Claude
 * runner box's tools do (claude-box-tools/entry.ts). The token is never an
 * account key. NEVER RUN against real Freestyle.
 */
export function freestyleScopedGuest(grant: {
	readonly vm: string;
	readonly token: string;
	readonly linuxUser: string;
}): GuestExec {
	const vm = new Freestyle({ identityAccessToken: grant.token }).vms
		.ref(grant.vm)
		.linuxUser(grant.linuxUser);
	return (options) => vm.exec(options);
}
