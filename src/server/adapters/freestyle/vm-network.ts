import type { Freestyle } from "freestyle";
import {
	normalizeAllowedDomain,
	type VmNetworkPolicy,
	vmEgressPlan,
} from "#/domain/vm-network-policy";

type Rules = Pick<Freestyle, "firewall" | "tls">;

/** Hosts the guest itself must reach in every mode (our git proxy). */
export function platformEgressDomains(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const out: string[] = [];
	for (const value of [env.YTIMESY_GIT_PROXY_URL]) {
		if (!value) continue;
		try {
			const host = normalizeAllowedDomain(new URL(value).hostname);
			if (host) out.push(host);
		} catch {}
	}
	return out;
}

/**
 * Makes one VM's egress match `policy`, idempotently: the open-internet
 * firewall grant exists only in `full`, and our passthrough TLS egress
 * rules (VM source, public destination, no transform) are exactly the plan's
 * domains. Grants are added before revocations so a switch never cuts the
 * VM off mid-way. Edge caches take about five seconds to notice changes.
 */
export async function applyVmNetworkPolicy(
	freestyle: Rules,
	vmId: string,
	policy: VmNetworkPolicy,
	platformDomains: readonly string[] = platformEgressDomains(),
) {
	const plan = vmEgressPlan(policy, platformDomains);
	const firewall = (await freestyle.firewall.rules.list({ vmId, limit: 100 }))
		.rules;
	const publicGrants = firewall.filter(
		(rule) =>
			rule.source.vmId === vmId &&
			rule.destination.public === true &&
			rule.destination.port === undefined,
	);
	const tls = (await freestyle.tls.rules.list({ vmId, limit: 100 })).rules;
	const egress = tls.filter(
		(rule) =>
			rule.source.vmId === vmId &&
			rule.destination.public === true &&
			!rule.managed &&
			!rule.transform?.length &&
			!rule.match &&
			rule.protocol === "http",
	);
	let added = 0;
	let removed = 0;
	for (const domain of plan.tlsDomains)
		if (!egress.some((rule) => rule.domain === domain)) {
			await freestyle.tls.rules.create(egressTlsRule(vmId, domain));
			added++;
		}
	if (plan.publicFirewall && publicGrants.length === 0) {
		await freestyle.firewall.rules.create({
			action: "allow",
			source: { vmId },
			destination: { public: true },
			description: "ytimesy: full internet access",
		});
		added++;
	}
	if (!plan.publicFirewall)
		for (const rule of publicGrants) {
			await ignoreMissing(freestyle.firewall.rules.delete(rule.id));
			removed++;
		}
	for (const rule of egress)
		if (!plan.tlsDomains.includes(rule.domain)) {
			await ignoreMissing(freestyle.tls.rules.delete(rule.id));
			removed++;
		}
	return { added, removed, plan };
}

export function egressTlsRule(vmId: string, domain: string) {
	return {
		action: "allow" as const,
		domain,
		source: { vmId },
		destination: { public: true as const },
	};
}

async function ignoreMissing(pending: Promise<void>) {
	await pending.catch((error: unknown) => {
		if (
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			error.status === 404
		)
			return;
		throw error;
	});
}
