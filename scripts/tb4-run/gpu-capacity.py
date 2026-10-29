"""GPU capacity loop for a TB4 run, run on the controller by tb4-gpu-capacity.timer (every 5 min).

Each run:
1. Counts the run's GPU instances (tags Run=<run id>, Role=gpu) in us-east-1 and us-west-2
   from EC2 itself, so a second launcher (the operator's laptop loop) cannot make it overshoot.
2. Launches p5.4xlarge on demand where the run is short: us-east-1 up to --east-max (any zone,
   one at a time, next zone on a capacity error), us-west-2 up to --west-max, never more than
   --total-max in all. Same shape as fleet.py: tags, termination protection, stop on shutdown,
   gp3 root kept per role, IMDSv2, the TB4 bootstrap as user data.
3. Deploys every running GPU instance that is not yet in hosts.json: waits for the bootstrap,
   copies the frozen source tree, run.env, trial caps, run-trial.sh, check-trial-env.sh and the
   AWS profile file (0600), installs dependencies, requires TRIAL-ENV-OK and an H100 from
   nvidia-smi, then adds the host to hosts.json (atomic rename) so queued GPU tasks start.
Logs one line per action to stdout (the systemd journal). Never prints credentials.

  uv run --with boto3 python gpu-capacity.py --run-id tb4-astra-2026-10-27 [--dry-run]
"""
import argparse
import json
import os
import subprocess
import sys
import time

import boto3
from botocore.exceptions import ClientError

PROFILE = os.environ.get("TB4_AWS_PROFILE", "harbor")
DLAMI_NAME = "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)*"
HERE = os.path.dirname(os.path.abspath(__file__))
ITYPE = "p5.4xlarge"


def log(*parts):
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), *parts, flush=True)


def ec2(region):
    return boto3.Session(profile_name=PROFILE, region_name=region).client("ec2")


def tags(run_id, name):
    return [
        {"Key": "Project", "Value": "ytimesy-tb4"},
        {"Key": "Run", "Value": run_id},
        {"Key": "Role", "Value": "gpu"},
        {"Key": "Name", "Value": name},
    ]


def gpu_instances(client, run_id):
    out = []
    pages = client.get_paginator("describe_instances").paginate(
        Filters=[
            {"Name": "tag:Run", "Values": [run_id]},
            {"Name": "tag:Role", "Values": ["gpu"]},
            {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
        ]
    )
    for page in pages:
        for r in page["Reservations"]:
            out.extend(r["Instances"])
    return out


def latest_ami(client):
    images = client.describe_images(
        Owners=["amazon"],
        Filters=[{"Name": "name", "Values": [DLAMI_NAME]}, {"Name": "state", "Values": ["available"]}],
    )["Images"]
    return max(images, key=lambda i: i["CreationDate"])["ImageId"]


def launch_one(client, region, run_id, key_name, sg, index, dry_run):
    with open(os.path.join(HERE, "host", "bootstrap.sh")) as f:
        user_data = f.read().replace("__ROLE__", "gpu")
    zones = [z["ZoneName"] for z in client.describe_availability_zones()["AvailabilityZones"] if z["State"] == "available"]
    offered = {
        o["Location"]
        for o in client.describe_instance_type_offerings(
            LocationType="availability-zone", Filters=[{"Name": "instance-type", "Values": [ITYPE]}]
        )["InstanceTypeOfferings"]
    }
    subnets = {s["AvailabilityZone"]: s["SubnetId"] for s in client.describe_subnets(Filters=[{"Name": "default-for-az", "Values": ["true"]}])["Subnets"]}
    ami = latest_ami(client)
    name = f"{run_id}-gpu-{region}-{index}"
    for zone in [z for z in zones if z in offered and z in subnets]:
        params = dict(
            ImageId=ami, InstanceType=ITYPE, MinCount=1, MaxCount=1, KeyName=key_name, UserData=user_data,
            InstanceInitiatedShutdownBehavior="stop", DisableApiTermination=True,
            BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": 1000, "VolumeType": "gp3", "DeleteOnTermination": True}}],
            TagSpecifications=[{"ResourceType": r, "Tags": tags(run_id, name)} for r in ("instance", "volume")],
            MetadataOptions={"HttpTokens": "required"}, SubnetId=subnets[zone], SecurityGroupIds=[sg], DryRun=dry_run,
        )
        try:
            iid = client.run_instances(**params)["Instances"][0]["InstanceId"]
            log("launched", region, zone, iid, name)
            return iid
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if dry_run and code == "DryRunOperation":
                log("dry-run ok", region, zone, name)
                return "dry-run"
            log("no launch", region, zone, code, e.response["Error"]["Message"][:120])
    return None


def ssh(address, key, command, timeout=600, stdin=None):
    return subprocess.run(
        ["ssh", "-i", key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", address, command],
        input=stdin, capture_output=True, timeout=timeout,
    )


def deploy(address, key, staged):
    """Copies the frozen tree and trial files to a booted GPU host; returns (ok, why)."""
    r = ssh(address, key, "grep -h -o 'TB4-BOOTSTRAP-[A-Z]*' /var/log/tb4-bootstrap.log | tail -1", timeout=60)
    state = r.stdout.decode().strip()
    if state != "TB4-BOOTSTRAP-DONE":
        return False, f"bootstrap {state or 'not started'}"
    with open(os.path.join(staged, "repo.tar.gz"), "rb") as f:
        r = ssh(address, key, "set -e; sudo mkdir -p /opt/tb4/ytimesy && sudo chown ubuntu:ubuntu /opt/tb4/ytimesy && tar -xzf - -C /opt/tb4/ytimesy && cd /opt/tb4/ytimesy && npx -y pnpm@10.20.0 install --frozen-lockfile > /opt/tb4/pnpm-install.log 2>&1 && echo ok", timeout=1200, stdin=f.read())
    if r.returncode:
        return False, "repo deploy failed: " + r.stderr.decode()[-200:]
    for local, remote, mode, owner in (
        ("run.env", "/opt/tb4/run.env", "644", "root"),
        ("trial-caps.json", "/opt/tb4/trial-caps.json", "644", "ubuntu"),
        ("run-trial.sh", "/opt/tb4/run-trial.sh", "755", "root"),
        ("check-trial-env.sh", "/opt/tb4/check-trial-env.sh", "755", "root"),
    ):
        with open(os.path.join(staged, local), "rb") as f:
            r = ssh(address, key, f"cat > /tmp/.f && sudo install -o {owner} -g {owner} -m {mode} /tmp/.f {remote} && rm -f /tmp/.f", stdin=f.read(), timeout=120)
        if r.returncode:
            return False, f"copy {local} failed"
    with open(os.path.join(staged, "aws-credentials"), "rb") as f:
        r = ssh(address, key, "umask 077; mkdir -p ~/.aws && cat > ~/.aws/credentials && chmod 600 ~/.aws/credentials && printf '[profile harbor]\\nregion = us-east-1\\n' > ~/.aws/config", stdin=f.read(), timeout=60)
    if r.returncode:
        return False, "credentials copy failed"
    with open(os.path.join(HERE, "host", "patch-harbor-probe.py"), "rb") as f:
        r = ssh(address, key, "/home/ubuntu/.local/share/uv/tools/harbor/bin/python - ", stdin=f.read(), timeout=120)
    if r.returncode:
        return False, "harbor probe patch failed: " + r.stdout.decode()[-160:]
    r = ssh(address, key, "sudo touch /opt/tb4/ledger.jsonl && sudo chown ubuntu:ubuntu /opt/tb4/ledger.jsonl /opt/tb4/jobs; nvidia-smi --query-gpu=name --format=csv,noheader; sudo systemd-run --wait --pipe --quiet /opt/tb4/check-trial-env.sh 2>&1 | tail -1", timeout=600)
    out = r.stdout.decode()
    if "H100" not in out:
        return False, "no H100 visible: " + out[-160:]
    if "TRIAL-ENV-OK" not in out:
        return False, "trial env check failed: " + out[-200:]
    return True, out.strip().splitlines()[-1]


def add_host(hosts_file, host):
    hosts = json.load(open(hosts_file)) if os.path.exists(hosts_file) else []
    if any(h["address"] == host["address"] for h in hosts):
        return False
    hosts.append(host)
    tmp = hosts_file + ".tmp"
    with open(tmp, "w") as f:
        json.dump(hosts, f, indent=2)
    os.replace(tmp, hosts_file)
    return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--run-id", required=True)
    p.add_argument("--hosts-file", default="/opt/tb4/run/hosts.json")
    p.add_argument("--staged", default="/opt/tb4/staged/gpu")
    p.add_argument("--east-max", type=int, default=5)
    p.add_argument("--west-max", type=int, default=1)
    p.add_argument("--total-max", type=int, default=5)
    p.add_argument("--east-key", default=os.path.expanduser("~/.ssh/id_ed25519"))
    p.add_argument("--west-key", default=os.path.expanduser("~/.ssh/tb4-west.pem"))
    p.add_argument("--east-sg", required=True)
    p.add_argument("--west-sg", required=True)
    p.add_argument("--key-name", default="tb4-astra-2026-10-27")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    regions = {
        "us-east-1": dict(client=ec2("us-east-1"), max=a.east_max, sg=a.east_sg, key=a.east_key, ip="PrivateIpAddress"),
        "us-west-2": dict(client=ec2("us-west-2"), max=a.west_max, sg=a.west_sg, key=a.west_key, ip="PublicIpAddress"),
    }
    have = {r: gpu_instances(v["client"], a.run_id) for r, v in regions.items()}
    total = sum(len(v) for v in have.values())
    log("gpu hosts", {r: len(v) for r, v in have.items()}, "total", total, "of", a.total_max)

    for region, v in regions.items():
        while len(have[region]) < v["max"] and total < a.total_max:
            iid = launch_one(v["client"], region, a.run_id, a.key_name, v["sg"], len(have[region]), a.dry_run)
            if not iid:
                log("no capacity", region)
                break
            if a.dry_run:
                break
            have[region].append({"InstanceId": iid, "State": {"Name": "pending"}})
            total += 1

    if a.dry_run:
        return
    for region, v in regions.items():
        for inst in gpu_instances(v["client"], a.run_id):
            if inst["State"]["Name"] != "running" or not inst.get(v["ip"]):
                continue
            address = f"ubuntu@{inst[v['ip']]}"
            hosts = json.load(open(a.hosts_file)) if os.path.exists(a.hosts_file) else []
            if any(h["address"] == address for h in hosts):
                continue
            if region != "us-east-1":
                # The controller's ssh/rsync to this host (public IP, the region's own key).
                cfg = os.path.expanduser("~/.ssh/config")
                ip = inst[v["ip"]]
                if f"Host {ip}\n" not in (open(cfg).read() if os.path.exists(cfg) else ""):
                    with open(cfg, "a") as f:
                        f.write(f"Host {ip}\n  User ubuntu\n  IdentityFile {v['key']}\n  StrictHostKeyChecking accept-new\n")
            ok, why = deploy(address, v["key"], a.staged)
            log("deploy", region, inst["InstanceId"], address, "ok" if ok else "pending", why)
            if ok:
                name = f"gpu-{region}-{inst['InstanceId'][-6:]}"
                if add_host(a.hosts_file, {"name": name, "kind": "gpu", "vcpu": 16, "memoryMb": 262144, "address": address}):
                    log("added host", name, address)


if __name__ == "__main__":
    sys.exit(main())
