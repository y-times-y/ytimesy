#!/usr/bin/env bash
# Materialize file-based secrets from runtime environment secrets.
#
# The server config points at two on-disk files that cannot be delivered as
# plain environment variables: the GitHub App private key and the Supabase CA
# certificate. Cloud Agent VMs receive their secrets as environment variables at
# boot, so this script runs on environment start (not install) to write those
# files into the paths the app expects. Placing it in start keeps it correct
# even if the environment later boots from a prebuilt build, where install runs
# at build time without runtime secrets.
#
# A missing secret warns but does not fail startup: the frontend still boots,
# and any server route that needs the secret fails loudly at request time via
# serverConfig(). Written files never enter Git because .secrets/ is ignored.
set -euo pipefail

secrets_dir=".secrets"
mkdir -p "$secrets_dir"

write_secret_file() {
	local var_name="$1"
	local target_path="$2"
	local value="${!var_name-}"

	if [ -z "$value" ]; then
		echo "write-secret-files: ${var_name} is not set; skipping ${target_path}" >&2
		return 0
	fi

	# Secrets may arrive with real newlines or with escaped \n sequences (how
	# multi-line values are stored in .env). printf %b normalizes both to real
	# newlines; PEM and certificate bodies contain no other backslash escapes,
	# so no unintended expansion occurs.
	printf '%b' "$value" >"$target_path"
	chmod 600 "$target_path"
	echo "write-secret-files: wrote ${target_path} from ${var_name}" >&2
}

write_secret_file GITHUB_PRIVATE_KEY "${secrets_dir}/github-app.pem"
write_secret_file SUPABASE_CA_CERT "${secrets_dir}/supabase-ca.crt"
