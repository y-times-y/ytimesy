"""Enlarges a runner box's disk while it runs (no downtime).

  python3 infra/claude-runner-box/grow-volume.py --instance i-0123 --size-gb 200 [--region us-east-2]

EBS volumes can grow but not shrink, and AWS allows one change per volume every
6 hours. The box's ytimesy-grow-root timer then grows the partition and the
filesystem within 15 minutes; /health shows the new share used.
"""
import argparse

import boto3

parser = argparse.ArgumentParser()
parser.add_argument("--instance", required=True)
parser.add_argument("--size-gb", type=int, required=True)
parser.add_argument("--region", default="us-east-2")
args = parser.parse_args()

ec2 = boto3.client("ec2", region_name=args.region)
reservation = ec2.describe_instances(InstanceIds=[args.instance])["Reservations"][0]["Instances"][0]
root = reservation["RootDeviceName"]
volume_id = next(m["Ebs"]["VolumeId"] for m in reservation["BlockDeviceMappings"] if m["DeviceName"] == root)
current = ec2.describe_volumes(VolumeIds=[volume_id])["Volumes"][0]["Size"]
if args.size_gb <= current:
    raise SystemExit(f"{volume_id} is already {current} GB; a volume can only grow.")
ec2.modify_volume(VolumeId=volume_id, Size=args.size_gb)
print(f"{volume_id}: {current} GB -> {args.size_gb} GB. The box grows its filesystem within 15 minutes.")
