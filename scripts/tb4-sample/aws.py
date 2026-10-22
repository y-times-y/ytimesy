"""EC2 for the TB4 sample (docs/tb4-sample-gate.md). boto3, profile `harbor`, us-east-1.

  python aws.py <state-dir> launch       key pair + SG (ssh from this laptop's IP) + one m7i.16xlarge
  python aws.py <state-dir> launch --dry-run   EC2 DryRun only (free permission check)
  python aws.py <state-dir> ipsync       re-point the SG at this laptop's current public IP
  python aws.py <state-dir> cleanup      terminate the instance; delete its volume, SG and key pair

Ported from the sk2 bridge trial scripts (m7i.4xlarge, 2026-10-21). Every resource is
tagged Project=ytimesy-tb4-sample. The host powers off (stop, not terminate, so the
results volume survives) 12 h after boot. Never prints credentials; the key is written
0600 into the state dir.
"""
import json
import os
import sys
import time
import urllib.request

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
PROFILE = os.environ.get("TB4_AWS_PROFILE", "harbor")
PROJECT = "ytimesy-tb4-sample"
TAG = [{"Key": "Project", "Value": PROJECT}]
# Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20261016: Docker preinstalled;
# the sk2 trial and the 2026-10-21 preflight ran on this family.
AMI = "ami-0e56f571f15c88d23"
INSTANCE_TYPE = os.environ.get("TB4_SAMPLE_INSTANCE", "m7i.16xlarge")
ROOT_GB = 500
HERE = os.path.dirname(os.path.abspath(__file__))


def ec2():
    return boto3.Session(profile_name=PROFILE, region_name=REGION).client("ec2")


def my_ip():
    return urllib.request.urlopen("https://checkip.amazonaws.com", timeout=10).read().decode().strip()


class State:
    def __init__(self, directory):
        os.makedirs(directory, exist_ok=True)
        self.directory = directory
        self.path = os.path.join(directory, "state.json")
        self.data = json.load(open(self.path)) if os.path.exists(self.path) else {}

    def save(self):
        with open(self.path, "w") as f:
            json.dump(self.data, f, indent=2)


def ssh_rule(cidr):
    return [{"IpProtocol": "tcp", "FromPort": 22, "ToPort": 22, "IpRanges": [{"CidrIp": cidr}]}]


def launch(st, dry_run):
    client = ec2()
    ip = my_ip()
    if dry_run:
        try:
            client.run_instances(ImageId=AMI, InstanceType=INSTANCE_TYPE, MinCount=1, MaxCount=1, DryRun=True)
        except ClientError as error:
            code = error.response["Error"]["Code"]
            print("dry run:", "OK" if code == "DryRunOperation" else code)
        return
    s = st.data
    if "key" not in s:
        name = f"{PROJECT}-{int(time.time())}"
        key = client.create_key_pair(KeyName=name, TagSpecifications=[{"ResourceType": "key-pair", "Tags": TAG}])
        path = os.path.join(st.directory, "key.pem")
        with open(path, "w") as f:
            f.write(key["KeyMaterial"])
        os.chmod(path, 0o600)
        s["key"] = name
        st.save()
    if "sg" not in s:
        vpc = client.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0]["VpcId"]
        group = client.create_security_group(
            GroupName=s["key"], Description="tb4 sample ssh", VpcId=vpc,
            TagSpecifications=[{"ResourceType": "security-group", "Tags": TAG}],
        )
        s["sg"] = group["GroupId"]
        st.save()
        client.authorize_security_group_ingress(GroupId=s["sg"], IpPermissions=ssh_rule(ip + "/32"))
        s["myip"] = ip
        st.save()
    if "instance" not in s:
        with open(os.path.join(HERE, "userdata.sh")) as f:
            user_data = f.read()
        result = client.run_instances(
            ImageId=AMI, InstanceType=INSTANCE_TYPE, MinCount=1, MaxCount=1, KeyName=s["key"],
            SecurityGroupIds=[s["sg"]], UserData=user_data,
            InstanceInitiatedShutdownBehavior="stop",
            BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {"VolumeSize": ROOT_GB, "VolumeType": "gp3", "DeleteOnTermination": True}}],
            TagSpecifications=[
                {"ResourceType": "instance", "Tags": TAG + [{"Key": "Name", "Value": "tb4-sample"}]},
                {"ResourceType": "volume", "Tags": TAG},
            ],
        )
        s["instance"] = result["Instances"][0]["InstanceId"]
        s["type"] = INSTANCE_TYPE
        s["launched"] = time.time()
        st.save()
    client.get_waiter("instance_running").wait(InstanceIds=[s["instance"]])
    described = client.describe_instances(InstanceIds=[s["instance"]])["Reservations"][0]["Instances"][0]
    s["ip"] = described["PublicIpAddress"]
    st.save()
    print(s["instance"], s["type"], s["ip"])


def ipsync(st):
    s = st.data
    ip = my_ip()
    if s.get("myip") == ip:
        return
    client = ec2()
    group = client.describe_security_groups(GroupIds=[s["sg"]])["SecurityGroups"][0]
    old = [r["CidrIp"] for p in group["IpPermissions"] for r in p.get("IpRanges", [])]
    if ip + "/32" not in old:
        client.authorize_security_group_ingress(GroupId=s["sg"], IpPermissions=ssh_rule(ip + "/32"))
    for cidr in old:
        if cidr != ip + "/32":
            client.revoke_security_group_ingress(GroupId=s["sg"], IpPermissions=ssh_rule(cidr))
    s["myip"] = ip
    st.save()
    print("sg updated for a new laptop IP", file=sys.stderr)


def cleanup(st):
    client = ec2()
    flt = [{"Name": "tag:Project", "Values": [PROJECT]}]
    live = ["pending", "running", "stopping", "stopped", "shutting-down"]

    def instances():
        return [i["InstanceId"] for r in client.describe_instances(Filters=flt + [{"Name": "instance-state-name", "Values": live}])["Reservations"] for i in r["Instances"]]

    ids = instances()
    print("terminating", ids)
    if ids:
        client.terminate_instances(InstanceIds=ids)
        client.get_waiter("instance_terminated").wait(InstanceIds=ids)
    for v in client.describe_volumes(Filters=flt)["Volumes"]:
        print("deleting volume", v["VolumeId"], v["State"])
        client.delete_volume(VolumeId=v["VolumeId"])
    for g in client.describe_security_groups(Filters=flt)["SecurityGroups"]:
        for _ in range(10):
            try:
                client.delete_security_group(GroupId=g["GroupId"])
                print("deleted sg", g["GroupId"])
                break
            except ClientError as error:
                print("sg retry", error.response["Error"]["Code"])
                time.sleep(10)
    for k in client.describe_key_pairs(Filters=flt)["KeyPairs"]:
        client.delete_key_pair(KeyPairId=k["KeyPairId"])
        print("deleted key", k["KeyName"])
    print("REMAINING instances", instances(), "volumes", [v["VolumeId"] for v in client.describe_volumes(Filters=flt)["Volumes"]])
    for key in ("instance", "ip", "sg", "key", "myip"):
        st.data.pop(key, None)
    st.save()


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    st = State(sys.argv[1])
    command = sys.argv[2]
    if command == "launch":
        launch(st, "--dry-run" in sys.argv)
    elif command == "ipsync":
        ipsync(st)
    elif command == "cleanup":
        cleanup(st)
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
