import { createHash } from "node:crypto";
import { Freestyle, type Vm } from "freestyle";
import { READER_USER_SETUP_SCRIPT } from "#/domain/subagent-reader";
import {
	CHEAP_BASE_RESOURCES,
	CHEAP_BASE_SNAPSHOT,
} from "#/server/adapters/freestyle/product-vm";
import { GUEST_INTERNET_FIREWALL } from "#/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "#/server/adapters/freestyle/wait-until-running";

// Builds the shared "tools" image that workspace VMs boot from (see
// src/domain/workspace-boot-snapshot.ts). No user data or credentials go in.
//
//   node --env-file=.env --import tsx scripts/build-tools-snapshot.ts           build (or reuse) and print the id
//   node --env-file=.env --import tsx scripts/build-tools-snapshot.ts --force   rebuild even if this recipe exists
//   node --env-file=.env --import tsx scripts/build-tools-snapshot.ts --verify sh-...   boot it and print versions
//
// The snapshot slug carries a hash of the recipe below, so a rerun with an
// unchanged recipe prints the existing id instead of building again.

const ROOT_STEPS: { name: string; script: string }[] = [
	{
		name: "fast login shells",
		// Auto-use mode makes every `bash -lc` pay ~200 ms for `nvm use`.
		// Load nvm without switching and put the default node first instead.
		script: `
node_bin="$(dirname "$(readlink -f /usr/local/bin/node)")"
cat > /etc/profile.d/nvm.sh <<EOF
export NVM_DIR=/usr/local/nvm
[ -s "\\$NVM_DIR/nvm.sh" ] && . "\\$NVM_DIR/nvm.sh" --no-use
case ":\\$PATH:" in *":$node_bin:"*) ;; *) PATH="$node_bin:\\$PATH" ;; esac
export PATH
EOF`,
	},
	{
		name: "apt packages",
		script: `
export DEBIAN_FRONTEND=noninteractive
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get -o DPkg::Lock::Timeout=180 update -qq
apt-get -o DPkg::Lock::Timeout=180 install -y -qq --no-install-recommends ripgrep gh openjdk-21-jdk-headless iptables >/dev/null
apt-get clean
rm -rf /var/lib/apt/lists/*`,
	},
	{
		name: "go",
		script: `
version="$(curl -fsSL 'https://go.dev/dl/?mode=json' | jq -r '[.[] | select(.stable)][0].version')"
if [ "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')" != "$version" ]; then
  rm -rf /usr/local/go
  curl -fsSL "https://go.dev/dl/$version.linux-amd64.tar.gz" | tar -C /usr/local -xz
fi
ln -sf /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/`,
	},
	{
		name: "rust",
		// System-wide toolchain owned by the agent user, so `cargo install`
		// and `rustup component add` work without sudo. /usr/local/bin gets
		// small wrappers because exec's non-login PATH never sees CARGO_HOME.
		script: `
export RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain stable -c clippy -c rustfmt
fi
"$CARGO_HOME/bin/rustup" component add clippy rustfmt >/dev/null 2>&1
for tool in "$CARGO_HOME"/bin/*; do
  name="$(basename "$tool")"
  printf '#!/bin/sh\\nexport RUSTUP_HOME="\${RUSTUP_HOME:-/usr/local/rustup}" CARGO_HOME="\${CARGO_HOME:-/usr/local/cargo}"\\nexec /usr/local/cargo/bin/%s "$@"\\n' "$name" > "/usr/local/bin/$name"
  chmod 0755 "/usr/local/bin/$name"
done
rm -rf "$RUSTUP_HOME/downloads" "$RUSTUP_HOME/tmp" "$CARGO_HOME/registry"
chown -R ubuntu:ubuntu "$RUSTUP_HOME" "$CARGO_HOME"`,
	},
	{
		name: "login PATH",
		script: `
cat > /etc/profile.d/ytimesy-tools.sh <<'EOF'
export RUSTUP_HOME="\${RUSTUP_HOME:-/usr/local/rustup}" CARGO_HOME="\${CARGO_HOME:-/usr/local/cargo}"
export JAVA_HOME="\${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}"
case ":$PATH:" in *":$CARGO_HOME/bin:"*) ;; *) PATH="$CARGO_HOME/bin:$PATH" ;; esac
case ":$PATH:" in *":$HOME/go/bin:"*) ;; *) PATH="$PATH:$HOME/go/bin" ;; esac
export PATH
EOF`,
	},
	{
		name: "pnpm and yarn",
		script: `corepack enable --install-directory /usr/local/bin pnpm yarn`,
	},
	{
		// Read-only subagents run their commands as this user (src/domain/subagent-reader.ts).
		name: "reader user",
		script: READER_USER_SETUP_SCRIPT,
	},
];

// Run per user so pnpm and yarn need no download on the first command.
const USER_STEP = `
cd /tmp
pnpm --version >/dev/null
yarn --version >/dev/null`;

const VERSIONS = `
for c in "node --version" "npm --version" "corepack --version" "pnpm --version" "yarn --version" "bun --version" \\
  "python3 --version" "pip --version" "uv --version" "go version" "rustc --version" "cargo --version" \\
  "cargo clippy --version" "rustfmt --version" "java -version" "javac -version" "gh --version" "rg --version" \\
  "git --version" "docker --version" "gcc --version" "make --version" "jq --version" "curl --version" "id ytimesy-reader" "iptables --version" "ip6tables --version"; do
  out="$($c 2>&1 | head -1)" || out="MISSING: $out"
  printf '%-24s %s\\n' "$c" "$out"
done`;

const TIMING = `bash -c 'TIMEFORMAT=%R; for i in 1 2 3; do time bash -lc true; done; for i in 1 2 3; do time bash -c true; done' 2>&1 | tr '\\n' ' '`;

const recipeHash = createHash("sha256")
	.update(JSON.stringify({ CHEAP_BASE_SNAPSHOT, ROOT_STEPS, USER_STEP }))
	.digest("hex")
	.slice(0, 12);
const SNAPSHOT_SLUG = `ytimesy-tools-${recipeHash}`;

const key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("FREESTYLE_API_KEY is required.");
const client = new Freestyle({ apiKey: key });

async function run(vm: Vm, label: string, script: string, linuxUser?: string) {
	const started = Date.now();
	const result = await vm.exec({
		command: `bash -euo pipefail -c "$(printf %s ${Buffer.from(script).toString("base64")} | base64 -d)"`,
		timeoutMs: 300_000,
		...(linuxUser ? { linuxUser } : {}),
	});
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (result.statusCode !== 0)
		throw new Error(
			`${label} failed (${result.statusCode}) after ${seconds}s:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		);
	console.error(`- ${label}: ${seconds}s`);
	return (result.stdout ?? "").trim();
}

async function bootVm(snapshotId: string, purpose: string) {
	const created = await client.vms.create({
		slug: `${SNAPSHOT_SLUG}-${purpose}-${Date.now().toString(36)}`,
		displayName: `ytimesy tools ${purpose}`,
		snapshotId,
		firewall: GUEST_INTERNET_FIREWALL,
		maxRunTotalSeconds: 3600,
		idleTimeoutSeconds: 900,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-proof" },
	});
	const { resources } = await waitUntilVmRunning(created.vm, "Tools VM");
	// Admission sizes the tools image as the base image without a source VM.
	if (
		resources.cpu !== CHEAP_BASE_RESOURCES.cpu ||
		resources.memory !== CHEAP_BASE_RESOURCES.memory ||
		resources.storage !== CHEAP_BASE_RESOURCES.storage
	) {
		await client.vms.ref(created.vmId).delete();
		throw new Error(`Unexpected VM size ${JSON.stringify(resources)}.`);
	}
	return { id: created.vmId, vm: created.vm };
}

async function report(vm: Vm) {
	console.error(await run(vm, "versions (agent user)", VERSIONS));
	console.error(
		"login PATH check:",
		await run(
			vm,
			"login shell tools",
			"bash -lc 'for c in node npm npx pnpm yarn bun go cargo rustc java gh rg uv; do command -v $c >/dev/null || echo missing:$c; done; echo ok'",
		),
	);
	console.error(
		"root check:",
		await run(
			vm,
			"root tools",
			"for c in node pnpm yarn go cargo java gh rg; do $c --version >/dev/null 2>&1 || $c version >/dev/null 2>&1 || echo missing:$c; done; echo ok",
			"root",
		),
	);
	console.error(
		"bash -lc x3, bash -c x3 (s):",
		await run(vm, "timing", TIMING),
	);
	console.error(await run(vm, "disk", "df -h /"));
}

async function existingSnapshot() {
	for (let offset = 0; ; offset += 100) {
		const { snapshots, totalCount } = await client.vms.snapshots.list({
			limit: 100,
			offset,
		});
		const found = snapshots.find(
			(snapshot) => snapshot.slug === SNAPSHOT_SLUG && !snapshot.public,
		);
		if (found) return found.id;
		if (offset + 100 >= totalCount) return undefined;
	}
}

async function verify(snapshotId: string) {
	const { id, vm } = await bootVm(snapshotId, "verify");
	try {
		await report(vm);
	} finally {
		await client.vms.ref(id).delete();
	}
}

async function build() {
	const { id, vm } = await bootVm(CHEAP_BASE_SNAPSHOT, "build");
	try {
		console.error(
			`builder ${id}; before:\n${await run(vm, "disk", "df -h /")}`,
		);
		console.error(
			"bash -lc x3, bash -c x3 (s):",
			await run(vm, "timing", TIMING),
		);
		for (const step of ROOT_STEPS)
			await run(vm, step.name, step.script, "root");
		await run(vm, "pnpm/yarn cache (ubuntu)", USER_STEP);
		await run(vm, "pnpm/yarn cache (root)", USER_STEP, "root");
		await report(vm);
		await run(
			vm,
			"clean",
			"rm -rf /root/.cache/go-build /home/ubuntu/.cache/go-build /tmp/* && sync",
			"root",
		);
		const created = await vm.snapshot({
			slug: SNAPSHOT_SLUG,
			displayName: "ytimesy tools image",
			autoDeleteSeconds: -1,
		});
		if (created.snapshot.public) {
			await client.vms.snapshots.delete(created.snapshotId);
			throw new Error("Freestyle returned a public snapshot; deleted it.");
		}
		return created.snapshotId;
	} finally {
		await client.vms.ref(id).delete();
	}
}

const args = process.argv.slice(2);
const verifyIndex = args.indexOf("--verify");
if (verifyIndex >= 0) {
	const snapshotId = args[verifyIndex + 1];
	if (!snapshotId?.startsWith("sh-")) throw new Error("--verify needs sh-...");
	await verify(snapshotId);
} else {
	const reused = args.includes("--force")
		? undefined
		: await existingSnapshot();
	const snapshotId = reused ?? (await build());
	console.error(reused ? `reusing ${SNAPSHOT_SLUG}` : `built ${SNAPSHOT_SLUG}`);
	console.log(snapshotId);
}
