/**
 * Cloud metadata endpoints a guest must never reach: the provider answers on
 * 169.254.169.254 (an AWS-style token PUT returned 200 in a live proof),
 * plus the ECS task address and AWS's IPv6 endpoint. Freestyle's egress
 * firewall does not cover link-local addresses, so each VM refuses them in
 * its own OUTPUT chain for every user (no owner match needed). Read-only
 * agents have no network at all (their own namespace).
 */
export const GUEST_METADATA_DESTINATIONS = [
	["iptables", "169.254.169.254"],
	["iptables", "169.254.170.2"],
	["ip6tables", "fd00:ec2::254"],
] as const;

/**
 * Root shell, idempotent and cheap when in place (one -C per rule): adds
 * each rule, verifies it with -C, and fails closed (non-zero) when a table
 * is missing or a rule does not hold. Rules do not survive a cold boot, so
 * every turn's workspace preparation runs it.
 */
export const GUEST_METADATA_BLOCK_SCRIPT = `set -u
for spec in ${GUEST_METADATA_DESTINATIONS.map(([table, destination]) => `${table},${destination}`).join(" ")}; do
  table=\${spec%%,*}; destination=\${spec#*,}
  command -v "$table" >/dev/null 2>&1 || { echo "ytimesy: $table unavailable; cloud metadata cannot be blocked" >&2; exit 1; }
  if ! "$table" -w -C OUTPUT -d "$destination" -j REJECT 2>/dev/null; then
    "$table" -w -I OUTPUT 1 -d "$destination" -j REJECT && "$table" -w -C OUTPUT -d "$destination" -j REJECT || { echo "ytimesy: $table refused the metadata rule for $destination" >&2; exit 1; }
  fi
done`;

/** Runs the block as root from the builder's user (passwordless sudo). */
export function guestMetadataBlockCommand() {
	return `sudo -n bash -c "$(printf %s ${Buffer.from(GUEST_METADATA_BLOCK_SCRIPT, "utf8").toString("base64")} | base64 -d)"`;
}
