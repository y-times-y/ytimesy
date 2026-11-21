#!/bin/bash
# First-boot setup of a turn runner box (Ubuntu 24.04 x86_64, run as root from
# the instance's user data; infra/turn-box/provision.py fills the placeholders).
# The box runs the model loop of turns the edge hands it (docs/turn-runner-boxes.md)
# and holds no production secret: its only credential is its identity token
# (__IDENTITY__), 24 hours, revocable at the edge, and the process refuses to
# start when anything else secret is in its environment.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates xz-utils

NODE_VERSION=22.11.0
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1

useradd --system --create-home --home-dir /var/lib/ytimesy-turn-box --shell /usr/sbin/nologin ytimesy-turn-box || true
install -d -o ytimesy-turn-box -g ytimesy-turn-box /opt/ytimesy-turn-box
# The program comes from the edge: a short-lived link to the current bundle in
# R2 and its checksum, given to this box's identity alone (GET /box/v1/bundle).
curl -fsS --retry 5 --retry-delay 5 -H 'authorization: Bearer __IDENTITY__' '__EDGE_URL__/box/v1/bundle' -o /tmp/bundle.json
BUNDLE_URL=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/tmp/bundle.json","utf8")).url)')
BUNDLE_SHA=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/tmp/bundle.json","utf8")).sha256)')
curl -fsS --retry 3 -o /tmp/turn-box.mjs.gz "$BUNDLE_URL"
gunzip -c /tmp/turn-box.mjs.gz > /opt/ytimesy-turn-box/turn-box.mjs
echo "$BUNDLE_SHA  /opt/ytimesy-turn-box/turn-box.mjs" | sha256sum -c -
rm -f /tmp/bundle.json /tmp/turn-box.mjs.gz

install -m 600 -o root -g root /dev/null /etc/ytimesy-turn-box.env
cat > /etc/ytimesy-turn-box.env <<'ENV'
YTIMESY_MODEL_EXECUTION_TARGET=durable-object
YTIMESY_EDGE_URL=__EDGE_URL__
YTIMESY_BOX_IDENTITY=__IDENTITY__
YTIMESY_TURN_BOX_ID=__BOX_ID__
ENV

install -m 644 /dev/null /var/log/ytimesy-turn-box.log
cat > /etc/systemd/system/ytimesy-turn-box.service <<'UNIT'
[Unit]
Description=ytimesy turn runner box
After=network-online.target
Wants=network-online.target
[Service]
User=ytimesy-turn-box
EnvironmentFile=/etc/ytimesy-turn-box.env
ExecStart=/usr/local/bin/node /opt/ytimesy-turn-box/turn-box.mjs
StandardOutput=append:/var/log/ytimesy-turn-box.log
StandardError=append:/var/log/ytimesy-turn-box.log
Restart=always
RestartSec=3
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
