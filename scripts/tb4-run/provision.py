"""TB4 fleet on AWS (docs/tb4-run-controller.md). boto3, profile `harbor`, us-east-1.

  python provision.py plan                       print the fleet and its hourly cost
  python provision.py up --dry-run               EC2 DryRun for every launch (free; checks permissions)
  python provision.py up --key-name K --subnet S --sg G [--only controller|cpu|gpu]
  python provision.py hosts > /opt/tb4/run/hosts.json
  python provision.py down --confirm <run-id>    terminate everything tagged with the run
  python provision.py budget --email hetkp16@gmail.com   AWS Budget 50/80/100% (needs budgets:ModifyBudget)
  python provision.py test-micro --key-name K    launch + terminate one t3.micro (bootstrap test)

Every resource is tagged Project=ytimesy-tb4 and Run=<run-id>. No instance has an
auto-terminate or TTL; the controller has termination protection and a root volume
that survives termination (DeleteOnTermination=false) so results outlive it.
Never prints credentials.
"""
import argparse
import json
import os
import sys
import time

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
PROFILE = os.environ.get("TB4_AWS_PROFILE", "harbor")
PROJECT = "ytimesy-tb4"
HERE = os.path.dirname(os.path.abspath(__file__))

FLEET = [
    # role, count, type, vcpu, memory MB, root GB
    ("controller", 1, "t3.small", 2, 2048, 200),
    ("cpu", 4, "m7i.16xlarge", 64, 262144, 1000),
    ("gpu", 1, "p5.4xlarge", 16, 262144, 1000),
]
HOURLY = {"t3.small": 0.0208, "m7i.16xlarge": 3.2256, "t3.micro": 0.0104}
# The IAM user lacks ssm:GetParameter: resolve the AMI by owner + name instead.
CANONICAL = "099720109477"
DLAMI_NAME = "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)*"


def session():
    return boto3.Session(profile_name=PROFILE, region_name=REGION)


def latest_ami(ec2, gpu):
    if gpu:
        owners, name = ["amazon"], DLAMI_NAME
    else:
        owners, name = [CANONICAL], "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
    images = ec2.describe_images(Owners=owners, Filters=[{"Name": "name", "Values": [name]}, {"Name": "state", "Values": ["available"]}])["Images"]
    if not images:
        raise SystemExit(f"no AMI matches {name}")
    return max(images, key=lambda i: i["CreationDate"])["ImageId"]


def tags(run_id, role, name):
    return [
        {"Key": "Project", "Value": PROJECT},
        {"Key": "Run", "Value": run_id},
        {"Key": "Role", "Value": role},
        {"Key": "Name", "Value": name},
    ]


def user_data(role):
    with open(os.path.join(HERE, "host", "bootstrap.sh")) as f:
        script = f.read()
    return script.replace("__ROLE__", role)


def launch(ec2, run_id, role, itype, root_gb, args, index, dry_run):
    name = f"{run_id}-{role}-{index}"
    params = dict(
        ImageId=latest_ami(ec2, role == "gpu"),
        InstanceType=itype,
        MinCount=1,
        MaxCount=1,
        KeyName=args.key_name or "tb4",
        UserData=user_data(role),
        InstanceInitiatedShutdownBehavior="stop",
        DisableApiTermination=(role == "controller"),
        BlockDeviceMappings=[{
            "DeviceName": "/dev/sda1",
            "Ebs": {"VolumeSize": root_gb, "VolumeType": "gp3", "DeleteOnTermination": role != "controller"},
        }],
        TagSpecifications=[
            {"ResourceType": "instance", "Tags": tags(run_id, role, name)},
            {"ResourceType": "volume", "Tags": tags(run_id, role, name)},
        ],
        MetadataOptions={"HttpTokens": "required"},
        DryRun=dry_run,
    )
    if args.subnet:
        params["SubnetId"] = args.subnet
    if args.sg:
        params["SecurityGroupIds"] = [args.sg]
    try:
        out = ec2.run_instances(**params)
        return out["Instances"][0]["InstanceId"]
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if dry_run and code == "DryRunOperation":
            return f"dry-run-ok:{name}"
        return f"error:{name}:{code}:{e.response['Error']['Message'][:160]}"


def cmd_plan(_args):
    total = 0.0
    for role, count, itype, vcpu, mem, root in FLEET:
        hourly = HOURLY.get(itype)
        total += (hourly or 0) * count
        print(f"{role:10} {count} x {itype:13} {vcpu:3} vCPU {mem // 1024:4} GB  root {root} GB  {('$%.2f/h' % hourly) if hourly else 'price: confirm on the EC2 pricing page'}")
    print(f"known hourly ${total:.2f}/h (p5.4xlarge excluded until its price is confirmed)")


def cmd_up(args):
    ec2 = session().client("ec2")
    out = []
    for role, count, itype, _vcpu, _mem, root in FLEET:
        if args.only and role != args.only:
            continue
        for i in range(count):
            out.append(launch(ec2, args.run_id, role, itype, root, args, i, args.dry_run))
    print(json.dumps(out, indent=2))


def cmd_hosts(args):
    ec2 = session().client("ec2")
    res = ec2.describe_instances(Filters=[
        {"Name": "tag:Project", "Values": [PROJECT]},
        {"Name": "tag:Run", "Values": [args.run_id]},
        {"Name": "instance-state-name", "Values": ["pending", "running"]},
    ])
    spec = {r: (v, m) for r, _c, _t, v, m, _g in FLEET}
    hosts = []
    for r in res["Reservations"]:
        for i in r["Instances"]:
            t = {x["Key"]: x["Value"] for x in i.get("Tags", [])}
            if t.get("Role") == "controller":
                continue
            vcpu, mem = spec[t["Role"]]
            hosts.append({
                "name": t["Name"], "kind": t["Role"], "vcpu": vcpu, "memoryMb": mem,
                "address": f"ubuntu@{i.get('PrivateIpAddress')}", "type": i["InstanceType"],
                "launchedAt": int(i["LaunchTime"].timestamp() * 1000), "instanceId": i["InstanceId"],
            })
    print(json.dumps(sorted(hosts, key=lambda h: h["name"]), indent=2))


def cmd_down(args):
    if args.confirm != args.run_id:
        raise SystemExit("pass --confirm <run-id> equal to --run-id; check the results backup first")
    ec2 = session().client("ec2")
    res = ec2.describe_instances(Filters=[
        {"Name": "tag:Project", "Values": [PROJECT]},
        {"Name": "tag:Run", "Values": [args.run_id]},
        {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]},
    ])
    ids = [i["InstanceId"] for r in res["Reservations"] for i in r["Instances"]]
    for iid in ids:
        ec2.modify_instance_attribute(InstanceId=iid, DisableApiTermination={"Value": False})
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
    print(json.dumps({"terminated": ids, "note": "the controller's root volume is kept (DeleteOnTermination=false); delete it after the second results copy is verified"}))


def cmd_budget(args):
    s = session()
    account = s.client("sts").get_caller_identity()["Account"]
    budgets = s.client("budgets")
    name = "ytimesy-tb4-monthly"
    budget = {
        "BudgetName": name,
        "BudgetLimit": {"Amount": str(args.amount), "Unit": "USD"},
        "TimeUnit": "MONTHLY",
        "BudgetType": "COST",
        # Account-wide (EC2 + Bedrock + Marketplace and everything else): no filter,
        # so a Bedrock model billed through Marketplace cannot slip past it.
        "CostTypes": {"IncludeTax": True, "IncludeSubscription": True, "UseBlended": False, "IncludeRefund": False, "IncludeCredit": False},
    }
    notes = [
        {"Notification": {"NotificationType": kind, "ComparisonOperator": "GREATER_THAN", "Threshold": pct, "ThresholdType": "PERCENTAGE"},
         "Subscribers": [{"SubscriptionType": "EMAIL", "Address": args.email}]}
        for pct, kind in [(50, "ACTUAL"), (80, "ACTUAL"), (100, "ACTUAL"), (100, "FORECASTED")]
    ]
    try:
        budgets.create_budget(AccountId=account, Budget=budget, NotificationsWithSubscribers=notes)
        print(json.dumps({"created": name, "amountUsd": args.amount, "thresholds": [50, 80, 100], "email": "set"}))
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code == "DuplicateRecordException":
            print(json.dumps({"exists": name}))
        else:
            print(json.dumps({"error": code, "fix": "run with an admin profile: TB4_AWS_PROFILE=<admin> python provision.py budget ..., or attach scripts/tb4-run/iam-tb4-operator.json to harbor-runner"}))
            sys.exit(1)


def cmd_test_micro(args):
    ec2 = session().client("ec2")
    iid = launch(ec2, args.run_id, "cpu-test", "t3.micro", 20, args, 0, False)
    if not iid.startswith("i-"):
        raise SystemExit(iid)
    print(f"launched {iid}; waiting for console output")
    try:
        ec2.get_waiter("instance_running").wait(InstanceIds=[iid])
        deadline = time.time() + args.wait
        out = ""
        while time.time() < deadline:
            out = ec2.get_console_output(InstanceId=iid, Latest=True).get("Output", "")
            if "TB4-BOOTSTRAP-DONE" in out or "TB4-BOOTSTRAP-FAILED" in out:
                break
            time.sleep(20)
        lines = [l for l in out.splitlines() if "TB4-" in l]
        print("\n".join(lines[-20:]) or "no TB4 lines yet")
    finally:
        ec2.modify_instance_attribute(InstanceId=iid, DisableApiTermination={"Value": False})
        ec2.terminate_instances(InstanceIds=[iid])
        print(f"terminated {iid}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["plan", "up", "hosts", "down", "budget", "test-micro"])
    p.add_argument("--run-id", default=os.environ.get("TB4_RUN_ID", "tb4b"))
    p.add_argument("--key-name")
    p.add_argument("--subnet")
    p.add_argument("--sg")
    p.add_argument("--only", choices=["controller", "cpu", "gpu"])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--confirm")
    p.add_argument("--email", default="hetkp16@gmail.com")
    p.add_argument("--amount", type=int, default=1500)
    p.add_argument("--wait", type=int, default=600)
    args = p.parse_args()
    {"plan": cmd_plan, "up": cmd_up, "hosts": cmd_hosts, "down": cmd_down, "budget": cmd_budget, "test-micro": cmd_test_micro}[args.command](args)


if __name__ == "__main__":
    main()
