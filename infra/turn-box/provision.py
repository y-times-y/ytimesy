"""Launches one turn runner box (run with boto3 and the repo checked out).

  node --import tsx scripts/build-turn-box.ts
  node --import tsx scripts/turn-box-keys.ts identity --private-key-file KEY --box-id NAME --out ID_FILE
  node --import tsx scripts/publish-turn-box.ts
  python3 infra/turn-box/provision.py --name NAME --identity-file ID_FILE

The box downloads its program from the edge (GET /box/v1/bundle) and checks its
SHA-256; publish-turn-box.ts puts the current one there. The box takes the instance profile `ytimesy-box`
(CloudWatch Logs only), no inbound port and IMDSv2. Prints the instance id.
Everything it creates is tagged ytimesy=turn-box so it can be found and removed.
"""
import argparse
from pathlib import Path

import boto3

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

parser = argparse.ArgumentParser()
parser.add_argument("--name", required=True)
parser.add_argument("--region", default="us-east-1")
parser.add_argument("--identity-file", required=True)
parser.add_argument("--edge-url", default="https://edge.ytimesy.com")
parser.add_argument("--log-group", default="/ytimesy/box")
parser.add_argument("--instance-type", default="t3.small")
parser.add_argument("--size-gb", type=int, default=20)
parser.add_argument("--profile", default="ytimesy-box")
args = parser.parse_args()

script = (HERE / "bootstrap.sh").read_text()
for placeholder, value in {
    "__EDGE_URL__": args.edge_url,
    "__IDENTITY__": Path(args.identity_file).read_text().strip(),
    "__BOX_ID__": args.name,
    "__LOG_GROUP__": args.log_group,
}.items():
    script = script.replace(placeholder, value)

tags = [{"Key": "ytimesy", "Value": "turn-box"}, {"Key": "Name", "Value": f"ytimesy-turn-box-{args.name}"}]
ec2 = boto3.client("ec2", region_name=args.region)
vpc = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0]["VpcId"]
group_name = "ytimesy-turn-box"
existing = ec2.describe_security_groups(
    Filters=[{"Name": "group-name", "Values": [group_name]}, {"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]
group = existing[0]["GroupId"] if existing else ec2.create_security_group(
    GroupName=group_name, Description="Turn runner box: no inbound rules", VpcId=vpc,
    TagSpecifications=[{"ResourceType": "security-group", "Tags": tags}])["GroupId"]
image = sorted(
    ec2.describe_images(Owners=["099720109477"], Filters=[
        {"Name": "name", "Values": ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]},
        {"Name": "state", "Values": ["available"]}])["Images"],
    key=lambda item: item["CreationDate"])[-1]["ImageId"]
run = ec2.run_instances(
    ImageId=image, InstanceType=args.instance_type, MinCount=1, MaxCount=1,
    SecurityGroupIds=[group], UserData=script,
    IamInstanceProfile={"Name": args.profile},
    MetadataOptions={"HttpTokens": "required", "HttpEndpoint": "enabled"},
    BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {
        "VolumeSize": args.size_gb, "VolumeType": "gp3", "DeleteOnTermination": True}}],
    TagSpecifications=[{"ResourceType": "instance", "Tags": tags}, {"ResourceType": "volume", "Tags": tags}])
print(run["Instances"][0]["InstanceId"])
