import { z } from "zod";

/**
 * Per-project internet access for chat machines (like other cloud agents).
 *
 * - `full`: open public internet (the firewall's `public: true` grant).
 * - `defaults`: only the built-in developer domains below plus the project's
 *   own domains.
 * - `allowlist`: only the project's own domains.
 *
 * Restricted modes drop the public firewall grant and add one Freestyle
 * Outbound TLS passthrough rule per domain (no transform, so the edge relays
 * TLS by SNI without decrypting). The VM's resolver steers only granted
 * names to the edge and refuses the rest. HTTPS (443, TCP) only: plain HTTP,
 * SSH, raw IPs, QUIC and DNS-over-HTTPS have no route. Cloud metadata stays
 * blocked in every mode by the in-VM rules (guest-network-guard).
 */
export const VM_NETWORK_MODES = ["full", "defaults", "allowlist"] as const;
export type VmNetworkMode = (typeof VM_NETWORK_MODES)[number];
export const DEFAULT_VM_NETWORK_MODE: VmNetworkMode = "full";
export const MAX_PROJECT_DOMAINS = 50;

/**
 * Package registries and common developer hosts. Wildcards match exactly one
 * label (`*.github.com` covers `api.github.com`, not `github.com` or
 * `a.b.github.com`), so apexes are listed beside them.
 */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
	// JavaScript
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"repo.yarnpkg.com",
	"nodejs.org",
	"bun.sh",
	"deno.land",
	"jsr.io",
	"npm.jsr.io",
	"dl.deno.land",
	// Python
	"pypi.org",
	"files.pythonhosted.org",
	"astral.sh",
	// Rust
	"crates.io",
	"index.crates.io",
	"static.crates.io",
	"static.rust-lang.org",
	"sh.rustup.rs",
	// Ruby
	"rubygems.org",
	"index.rubygems.org",
	// Go
	"proxy.golang.org",
	"sum.golang.org",
	"go.dev",
	"dl.google.com",
	// Java
	"repo.maven.apache.org",
	"repo1.maven.org",
	"plugins.gradle.org",
	"services.gradle.org",
	// GitHub
	"github.com",
	"*.github.com",
	"raw.githubusercontent.com",
	"objects.githubusercontent.com",
	"codeload.github.com",
	"ghcr.io",
	"pkg-containers.githubusercontent.com",
	// Containers
	"registry-1.docker.io",
	"auth.docker.io",
	"production.cloudflare.docker.com",
	"index.docker.io",
	// Ubuntu / Debian packages
	"archive.ubuntu.com",
	"security.ubuntu.com",
	"ports.ubuntu.com",
	"deb.debian.org",
	"security.debian.org",
];

const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lowercased exact hostname or `*.suffix` (one-label wildcard); null when invalid. */
export function normalizeAllowedDomain(value: string): string | null {
	const domain = value.trim().toLowerCase().replace(/\.$/, "");
	if (!domain || domain.length > 253) return null;
	const wildcard = domain.startsWith("*.");
	const labels = (wildcard ? domain.slice(2) : domain).split(".");
	if (labels.length < 2 || !labels.every((part) => label.test(part)))
		return null;
	if (/^\d+$/.test(labels[labels.length - 1] ?? "")) return null; // an IP
	if (wildcard && labels.length < 2) return null;
	return domain;
}

export const vmNetworkPolicy = z.object({
	mode: z.enum(VM_NETWORK_MODES),
	domains: z
		.array(z.string())
		.max(MAX_PROJECT_DOMAINS, `At most ${MAX_PROJECT_DOMAINS} domains.`)
		.transform((values, context) => {
			const out: string[] = [];
			for (const value of values) {
				const domain = normalizeAllowedDomain(value);
				if (!domain) {
					context.addIssue({
						code: "custom",
						message: `"${value.slice(0, 80)}" is not a domain. Use a hostname like api.example.com or *.example.com.`,
					});
					return z.NEVER;
				}
				if (!out.includes(domain)) out.push(domain);
			}
			return out;
		}),
});
export type VmNetworkPolicy = z.infer<typeof vmNetworkPolicy>;

export const DEFAULT_VM_NETWORK_POLICY: VmNetworkPolicy = {
	mode: DEFAULT_VM_NETWORK_MODE,
	domains: [],
};

/** Parses the textarea form: one domain per line, commas or spaces also split. */
export function parseDomainList(text: string): string[] {
	return text
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * The egress grants a policy needs. `publicFirewall` is the open-internet
 * firewall grant; `tlsDomains` are the Outbound TLS passthrough names.
 * `platformDomains` (our own git proxy, for example) are always granted in
 * restricted modes so the product keeps working.
 */
export function vmEgressPlan(
	policy: VmNetworkPolicy,
	platformDomains: readonly string[] = [],
): { publicFirewall: boolean; tlsDomains: string[] } {
	if (policy.mode === "full") return { publicFirewall: true, tlsDomains: [] };
	const wanted = [
		...(policy.mode === "defaults" ? DEFAULT_ALLOWED_DOMAINS : []),
		...policy.domains,
		...platformDomains,
	];
	const tlsDomains: string[] = [];
	for (const value of wanted) {
		const domain = normalizeAllowedDomain(value);
		if (domain && !tlsDomains.includes(domain)) tlsDomains.push(domain);
	}
	return { publicFirewall: false, tlsDomains };
}
