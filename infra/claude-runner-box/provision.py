"""Launches one runner box (run with boto3 and the repo checked out).

  python3 infra/claude-runner-box/provision.py --name runner-1 --region us-east-2 \
      --signing-key-file KEY --size-gb 100 [--tunnel-token-file TOKEN]

Prints the instance id. The disk is large on purpose: a chat's Claude session
file can be hundreds of MB and the box keeps it between turns; cleanup.mjs
evicts old ones. With --tunnel-token-file the box makes an outbound
Cloudflare Tunnel connection and needs no inbound port; without it the
security group is created with no ingress rules.
"""
import argparse
import subprocess
from pathlib import Path

import boto3

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

parser = argparse.ArgumentParser()
parser.add_argument("--name", required=True)
parser.add_argument("--region", default="us-east-2")
parser.add_argument("--signing-key-file", required=True)
parser.add_argument("--tunnel-token-file")
parser.add_argument("--size-gb", type=int, default=100)
parser.add_argument("--instance-type", default="t4g.small")
args = parser.parse_args()

key = Path(args.signing_key_file).read_text().strip()
assert len(key) >= 32, "signing key must be 32+ characters"
token = Path(args.tunnel_token_file).read_text().strip() if args.tunnel_token_file else ""
sdk_install = subprocess.check_output(
    ["node", "--import", "tsx", "-e",
     "import('./src/domain/guest-cli-pin.ts').then((m) => process.stdout.write(m.claudeAgentSdkInstallScript(true)))"],
    cwd=ROOT, text=True)
script = (HERE / "bootstrap.sh").read_text()
for placeholder, value in {
    "__SIGNING_KEY__": key,
    "__TUNNEL_TOKEN__": token,
    "__SERVER_MJS__": (HERE / "server.mjs").read_text(),
    "__CLEANUP_MJS__": (HERE / "cleanup.mjs").read_text(),
    "__SDK_INSTALL__": sdk_install,
}.items():
    script = script.replace(placeholder, value)

ec2 = boto3.client("ec2", region_name=args.region)
vpc = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0]["VpcId"]
group = ec2.create_security_group(
    GroupName=f"ytimesy-{args.name}", Description="Claude runner box: no inbound rules", VpcId=vpc)["GroupId"]
image = sorted(
    ec2.describe_images(Owners=["099720109477"], Filters=[
        {"Name": "name", "Values": ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"]},
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
