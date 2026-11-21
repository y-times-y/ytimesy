#!/bin/bash
# First-boot setup of a turn runner box (Ubuntu 24.04 x86_64, run as root from
# the launch template's user data; infra/turn-box/fleet.py fills the
# placeholders). The user data holds NO credential: each time the service
# starts, start.mjs proves the instance's role to the edge (STS) and receives
# an identity for this instance, then downloads the current program. The box
# holds no production secret (docs/turn-runner-boxes.md, "No secrets on a box").
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates xz-utils

NODE_VERSION=22.11.0
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1

useradd --system --create-home --home-dir /var/lib/ytimesy-turn-box --shell /usr/sbin/nologin ytimesy-turn-box || true
install -d -o root -g root /opt/ytimesy-turn-box
cat > /opt/ytimesy-turn-box/sigv4.mjs <<'SIGV4'
__SIGV4_MJS__
SIGV4
cat > /opt/ytimesy-turn-box/start.mjs <<'START'
__START_MJS__
START
chmod 755 /opt/ytimesy-turn-box
# The program is written by start.mjs (root) and read by the service user.
install -m 644 /dev/null /opt/ytimesy-turn-box/turn-box.mjs

install -m 644 /dev/null /var/log/ytimesy-turn-box.log
chown ytimesy-turn-box /var/log/ytimesy-turn-box.log
cat > /etc/systemd/system/ytimesy-turn-box.service <<'UNIT'
[Unit]
Description=ytimesy turn runner box
After=network-online.target
Wants=network-online.target
[Service]
User=ytimesy-turn-box
Environment=YTIMESY_EDGE_URL=__EDGE_URL__
# Enroll (a fresh identity for this instance) and fetch the program, as root.
ExecStartPre=+/usr/local/bin/node /opt/ytimesy-turn-box/start.mjs
# "-": the file does not exist until the ExecStartPre below writes it; without
# it systemd refuses to start the unit at all.
EnvironmentFile=-/run/ytimesy-turn-box.env
ExecStart=/usr/local/bin/node /opt/ytimesy-turn-box/turn-box.mjs
StandardOutput=append:/var/log/ytimesy-turn-box.log
StandardError=append:/var/log/ytimesy-turn-box.log
Restart=always
RestartSec=5
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
UNIT

# Logs go to CloudWatch with the instance role (CloudWatchAgentServerPolicy).
curl -fsSL -o /tmp/cwagent.deb https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
dpkg -i /tmp/cwagent.deb
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'CW'
{"logs":{"logs_collected":{"files":{"collect_list":[
 {"file_path":"/var/log/ytimesy-turn-box.log","log_group_name":"__LOG_GROUP__","log_stream_name":"{instance_id}","retention_in_days":14},
 {"file_path":"/var/log/cloud-init-output.log","log_group_name":"__LOG_GROUP__","log_stream_name":"{instance_id}-boot"}
]}}}}
CW
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

systemctl daemon-reload
systemctl enable --now ytimesy-turn-box.service
