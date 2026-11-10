#!/bin/bash
# First-boot setup of a runner box (Ubuntu 24.04 arm64, run as root from the
# instance's user data). The provisioning script fills the three placeholders.
# The box runs `claude` only: no repository, no user secrets, no inbound ports
# when reached through a Cloudflare Tunnel (__TUNNEL_TOKEN__ set).
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 curl ca-certificates xz-utils git

# Node at the path the runner expects (/usr/local/bin/node).
NODE_VERSION=22.11.0
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" | tar -xJ -C /usr/local --strip-components=1

useradd --system --create-home --home-dir /var/lib/ytimesy-runner --shell /usr/sbin/nologin ytimesy-runner || true
install -d -o ytimesy-runner -g ytimesy-runner /var/lib/ytimesy-runner/work /opt/ytimesy-runner
install -m 600 -o root -g root /dev/null /etc/ytimesy-runner.env
printf 'RUNNER_SIGNING_KEY=%s\nRUNNER_HOME=/var/lib/ytimesy-runner\nPORT=8787\n' '__SIGNING_KEY__' > /etc/ytimesy-runner.env

cat > /opt/ytimesy-runner/server.mjs <<'SERVER'
__SERVER_MJS__
SERVER
cat > /opt/ytimesy-runner/cleanup.mjs <<'CLEANUP'
__CLEANUP_MJS__
CLEANUP

# The pinned Claude Agent SDK, at the path the runner checks.
__SDK_INSTALL__

cat > /etc/systemd/system/ytimesy-runner.service <<'UNIT'
[Unit]
Description=ytimesy Claude runner box API
After=network-online.target
Wants=network-online.target
[Service]
User=ytimesy-runner
EnvironmentFile=/etc/ytimesy-runner.env
ExecStart=/usr/local/bin/node /opt/ytimesy-runner/server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
UNIT

# Disk: session files go by age, and least-recently-used when the disk is nearly full.
cat > /etc/systemd/system/ytimesy-runner-cleanup.service <<'UNIT'
[Unit]
Description=ytimesy runner box cleanup
[Service]
Type=oneshot
User=ytimesy-runner
Environment=RUNNER_HOME=/var/lib/ytimesy-runner
ExecStart=/usr/local/bin/node /opt/ytimesy-runner/cleanup.mjs
UNIT
cat > /etc/systemd/system/ytimesy-runner-cleanup.timer <<'UNIT'
[Unit]
Description=ytimesy runner box cleanup, every 15 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
UNIT

if [ -n '__TUNNEL_TOKEN__' ]; then
  curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
  dpkg -i /tmp/cloudflared.deb
  cloudflared service install '__TUNNEL_TOKEN__'
fi

systemctl daemon-reload
systemctl enable --now ytimesy-runner.service ytimesy-runner-cleanup.timer
