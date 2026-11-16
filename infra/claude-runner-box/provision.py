"""Launches one runner box (run with boto3 and the repo checked out).

  python3 infra/claude-runner-box/provision.py --name runner-1 --region us-east-2 \
      --public-key PUBLIC_KEY --size-gb 100 [--tunnel-token-file TOKEN]

PUBLIC_KEY is the edge's Ed25519 public key that
scripts/generate-claude-runner-keypair.ts prints (base64 SPKI); the box gets
no key that can sign a request. Prints the instance id. The disk is large on purpose: a chat's Claude session
file can be hundreds of MB and the box keeps it between turns; cleanup.mjs
evicts old ones. With --tunnel-token-file the box makes an outbound
Cloudflare Tunnel connection and needs no inbound port; without it the
security group is created with no ingress rules.
"""
import argparse
import re
import subprocess
from pathlib import Path

import boto3

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

parser = argparse.ArgumentParser()
parser.add_argument("--name", required=True)
parser.add_argument("--region", default="us-east-2")
parser.add_argument("--public-key", required=True)
parser.add_argument("--tunnel-token-file")
parser.add_argument("--size-gb", type=int, default=100)
parser.add_argument("--instance-type", default="t3.small")
args = parser.parse_args()

key = args.public_key.strip()
# An Ed25519 SPKI DER is 44 bytes: 60 base64 characters ending in "=".
assert re.fullmatch(r"[A-Za-z0-9+/]{59}=", key), "--public-key must be the base64 SPKI the keypair script prints"
token = Path(args.tunnel_token_file).read_text().strip() if args.tunnel_token_file else ""
sdk_install = subprocess.check_output(
    ["node", "--import", "tsx", "-e",
     "import('./src/domain/guest-cli-pin.ts').then((m) => process.stdout.write(m.claudeAgentSdkInstallScript(true)))"],
    cwd=ROOT, text=True)
script = (HERE / "bootstrap.sh").read_text()
for placeholder, value in {
    "__PUBLIC_KEY__": key,
    "__TUNNEL_TOKEN__": token,
    "__SERVER_MJS__": (HERE / "server.mjs").read_text(),
    "__CLEANUP_MJS__": (HERE / "cleanup.mjs").read_text(),
    "__SDK_INSTALL__": sdk_install,
}.items():
    script = script.replace(placeholder, value)

ec2 = boto3.client("ec2", region_name=args.region)
vpc = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0]["VpcId"]
existing = ec2.describe_security_groups(
    Filters=[{"Name": "group-name", "Values": [f"ytimesy-{args.name}"]}, {"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]
group = existing[0]["GroupId"] if existing else ec2.create_security_group(
    GroupName=f"ytimesy-{args.name}", Description="Claude runner box: no inbound rules", VpcId=vpc)["GroupId"]
image = sorted(
    ec2.describe_images(Owners=["099720109477"], Filters=[
        {"Name": "name", "Values": ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]},
        {"Name": "state", "Values": ["available"]}])["Images"],
    key=lambda item: item["CreationDate"])[-1]["ImageId"]
run = ec2.run_instances(
    ImageId=image, InstanceType=args.instance_type, MinCount=1, MaxCount=1,
    SecurityGroupIds=[group], UserData=script,
    MetadataOptions={"HttpTokens": "required", "HttpEndpoint": "enabled"},
    BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {
        "VolumeSize": args.size_gb, "VolumeType": "gp3", "DeleteOnTermination": True}}],
    TagSpecifications=[{"ResourceType": "instance", "Tags": [{"Key": "Name", "Value": f"ytimesy-{args.name}"}]}])
print(run["Instances"][0]["InstanceId"])
