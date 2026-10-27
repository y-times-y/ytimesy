#!/bin/bash
# EC2 user-data for TB4 hosts (role __ROLE__): Docker, uv + Harbor 0.24.0, Node 22,
# /opt/tb4 layout. Secrets (Bedrock creds, R2 backup keys, alert webhook) are NOT
# here: the operator copies them with scp after boot (docs/tb4-run-controller.md).
set -uo pipefail
exec > >(tee -a /var/log/tb4-bootstrap.log | logger -t tb4 -s 2>/dev/console) 2>&1
echo "TB4-BOOTSTRAP-START role=__ROLE__"
fail() { echo "TB4-BOOTSTRAP-FAILED $*"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -y >/dev/null || fail apt-update
apt-get install -y ca-certificates curl git rsync jq unzip >/dev/null || fail apt-install
if [ "__ROLE__" != "controller" ] && [ "__ROLE__" != "controller-test" ]; then
  command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sh >/dev/null) || fail docker
  usermod -aG docker ubuntu
  systemctl enable --now docker
  # dockerd caches NCPU at start (Freestyle lesson): restart once after boot.
  systemctl restart docker
  [ "$(docker info --format '{{.NCPU}}')" = "$(nproc)" ] || fail "docker NCPU != nproc"
  # Verifiers with allow_internet = false (batched-eval-parity, lake-temp-glm) need
  # Harbor's Docker egress-control sidecar, which needs nftables fib inet rules
  # (CONFIG_NFT_FIB_INET). Without it Harbor rejects the verifier after the agent ran.
  # Docker Desktop's linuxkit kernel lacks it; Ubuntu's AWS kernel ships it as a module.
  if [ -f "/boot/config-$(uname -r)" ]; then
    grep -qE '^CONFIG_NFT_FIB_INET=[ym]' "/boot/config-$(uname -r)" || fail "kernel lacks CONFIG_NFT_FIB_INET (no-network verifiers)"
  fi
  modprobe nft_fib_inet 2>/dev/null || grep -qE '^CONFIG_NFT_FIB_INET=y' "/boot/config-$(uname -r)" 2>/dev/null || fail "nft_fib_inet module not loadable"
fi
if [ "__ROLE__" = "gpu" ]; then
  nvidia-smi --query-gpu=name --format=csv,noheader | grep -q "H100" || fail "no H100 visible"
  command -v nvidia-ctk >/dev/null && nvidia-ctk runtime configure --runtime=docker && systemctl restart docker
fi
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null || fail uv
sudo -u ubuntu /usr/local/bin/uv tool install harbor==0.24.0 >/dev/null || fail harbor
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && apt-get install -y nodejs >/dev/null || fail node
mkdir -p /opt/tb4/jobs /opt/tb4/run /opt/tb4/results && chown -R ubuntu:ubuntu /opt/tb4
echo "TB4-BOOTSTRAP-DONE role=__ROLE__ docker=$(docker --version 2>/dev/null | cut -d, -f1) node=$(node -v) harbor=$(sudo -u ubuntu /home/ubuntu/.local/bin/harbor --version 2>/dev/null || echo installed)"
