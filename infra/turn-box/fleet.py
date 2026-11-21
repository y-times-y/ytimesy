"""Creates or updates the turn runner box fleet: a launch template and an
Auto Scaling group that keeps `--min` boxes running (run with boto3 and the
repo checked out).

  node --import tsx scripts/publish-turn-box.ts      # the program the boxes fetch
  python3 infra/turn-box/fleet.py [--min 2 --max 6 --instance-type t3.small]

Boxes enroll themselves (infra/turn-box/start.mjs): the launch template holds
no credential. A box that dies is replaced by the group. Everything is tagged
ytimesy=turn-box. `--delete` removes the group, template and security group.
"""
import argparse
import base64
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

HERE = Path(__file__).resolve().parent

parser = argparse.ArgumentParser()
parser.add_argument("--region", default="us-east-1")
parser.add_argument("--min", type=int, default=2)
parser.add_argument("--max", type=int, default=6)
parser.add_argument("--instance-type", default="t3.small")
parser.add_argument("--size-gb", type=int, default=20)
parser.add_argument("--edge-url", default="https://edge.ytimesy.com")
parser.add_argument("--log-group", default="/ytimesy/box")
parser.add_argument("--profile", default="ytimesy-box")
parser.add_argument("--name", default="ytimesy-turn-box")
parser.add_argument("--delete", action="store_true")
args = parser.parse_args()

ec2 = boto3.client("ec2", region_name=args.region)
asg = boto3.client("autoscaling", region_name=args.region)
tags = [{"Key": "ytimesy", "Value": "turn-box"}]

if args.delete:
    try:
        asg.delete_auto_scaling_group(AutoScalingGroupName=args.name, ForceDelete=True)
    except ClientError as error:
        print("group:", error.response["Error"]["Code"])
    for _ in range(60):
        if not asg.describe_auto_scaling_groups(AutoScalingGroupNames=[args.name])["AutoScalingGroups"]:
            break
        __import__("time").sleep(5)
    try:
        ec2.delete_launch_template(LaunchTemplateName=args.name)
    except ClientError as error:
        print("template:", error.response["Error"]["Code"])
    print("deleted the group and the template (the security group stays: it is free)")
    raise SystemExit

script = (HERE / "bootstrap.sh").read_text()
for placeholder, value in {
    "__SIGV4_MJS__": (HERE / "sigv4.mjs").read_text().rstrip("\n"),
    "__START_MJS__": (HERE / "start.mjs").read_text().rstrip("\n"),
    "__EDGE_URL__": args.edge_url,
    "__LOG_GROUP__": args.log_group,
}.items():
    script = script.replace(placeholder, value)
assert len(script.encode()) < 16000, "user data would exceed 16 KB"

vpc = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"][0]["VpcId"]
existing = ec2.describe_security_groups(
    Filters=[{"Name": "group-name", "Values": [args.name]}, {"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]
group = existing[0]["GroupId"] if existing else ec2.create_security_group(
    GroupName=args.name, Description="Turn runner box: no inbound rules", VpcId=vpc,
    TagSpecifications=[{"ResourceType": "security-group", "Tags": tags}])["GroupId"]
image = sorted(
    ec2.describe_images(Owners=["099720109477"], Filters=[
        {"Name": "name", "Values": ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]},
        {"Name": "state", "Values": ["available"]}])["Images"],
    key=lambda item: item["CreationDate"])[-1]["ImageId"]
data = {
    "ImageId": image,
    "InstanceType": args.instance_type,
    "SecurityGroupIds": [group],
    "UserData": base64.b64encode(script.encode()).decode(),
    "IamInstanceProfile": {"Name": args.profile},
    "MetadataOptions": {"HttpTokens": "required", "HttpEndpoint": "enabled", "HttpPutResponseHopLimit": 1},
    "BlockDeviceMappings": [{"DeviceName": "/dev/sda1", "Ebs": {
        "VolumeSize": args.size_gb, "VolumeType": "gp3", "DeleteOnTermination": True}}],
    "TagSpecifications": [
        {"ResourceType": "instance", "Tags": tags + [{"Key": "Name", "Value": args.name}]},
        {"ResourceType": "volume", "Tags": tags}],
}
try:
    template = ec2.create_launch_template(LaunchTemplateName=args.name, LaunchTemplateData=data,
        TagSpecifications=[{"ResourceType": "launch-template", "Tags": tags}])["LaunchTemplate"]
    version = "1"
except ClientError as error:
    if error.response["Error"]["Code"] != "InvalidLaunchTemplateName.AlreadyExistsException":
        raise
    version = str(ec2.create_launch_template_version(LaunchTemplateName=args.name, LaunchTemplateData=data,
        SourceVersion="$Latest")["LaunchTemplateVersion"]["VersionNumber"])
    ec2.modify_launch_template(LaunchTemplateName=args.name, DefaultVersion=version)

subnets = [s["SubnetId"] for s in ec2.describe_subnets(Filters=[
    {"Name": "vpc-id", "Values": [vpc]}, {"Name": "default-for-az", "Values": ["true"]}])["Subnets"]]
spec = {
    "AutoScalingGroupName": args.name,
    "LaunchTemplate": {"LaunchTemplateName": args.name, "Version": "$Default"},
    "MinSize": args.min, "MaxSize": args.max, "DesiredCapacity": args.min,
    "VPCZoneIdentifier": ",".join(subnets),
    "HealthCheckType": "EC2", "HealthCheckGracePeriod": 300,
    "Tags": [{"Key": "ytimesy", "Value": "turn-box", "PropagateAtLaunch": True, "ResourceId": args.name, "ResourceType": "auto-scaling-group"}],
}
if asg.describe_auto_scaling_groups(AutoScalingGroupNames=[args.name])["AutoScalingGroups"]:
    spec.pop("Tags")
    asg.update_auto_scaling_group(**spec)
    # Boxes already running keep their old template; replace them one at a time.
    asg.start_instance_refresh(AutoScalingGroupName=args.name, Preferences={"MinHealthyPercentage": 50})
    print(f"updated {args.name} to template version {version}; refreshing boxes")
else:
    asg.create_auto_scaling_group(**spec)
    print(f"created {args.name}: {args.min}-{args.max} x {args.instance_type}, template version {version}")
