#!/bin/bash
# EC2 user-data for the TB4 sample host (from the sk2 bridge trial). No secrets here:
# Bedrock credentials are copied with scp after boot (sample.sh setup).
# Safety net: power off after 12 h (the instance stops; its volume and results survive).
shutdown -h +720 &
exec > /var/log/tb4s-setup.log 2>&1
set -x
python3 - <<'PY'
import json,os
p='/etc/docker/daemon.json'
d=json.load(open(p)) if os.path.exists(p) else {}
d['default-address-pools']=[{'base':'10.200.0.0/14','size':24}]
json.dump(d,open(p,'w'),indent=2)
PY
# dockerd caches NCPU at start: restart once after boot.
systemctl restart docker
usermod -aG docker ubuntu
[ "$(docker info --format '{{.NCPU}}')" = "$(nproc)" ] || echo "WARN docker NCPU != nproc"
sudo -u ubuntu bash -lc 'curl -LsSf https://astral.sh/uv/install.sh | sh'
sudo -u ubuntu bash -lc '~/.local/bin/uv tool install harbor==0.24.0 || true; ~/.local/bin/uvx --from harbor==0.24.0 harbor --help >/dev/null'
cd /opt && curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz | tar xJ && ln -sf /opt/node-v22.11.0-linux-x64/bin/* /usr/local/bin/
docker compose version
touch /var/log/tb4s-setup.done
