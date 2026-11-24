/**
 * The AWS turn runner box fleet (us-east-1), as code: the instance role the
 * edge's enrollment check expects, its instance profile, a security group
 * with no inbound rules, the box log group, the launch template that runs
 * infra/turn-box/bootstrap.sh, the Auto Scaling group, CPU target tracking
 * and alarms. Replaces infra/turn-box/fleet.py and the hand-made IAM role.
 *
 * Run only through scripts/infra.ts (it plans first and refuses deletions
 * and replacements of the protected resources below):
 *
 *   node --import tsx scripts/infra.ts plan aws --stage production
 *
 * Production only: there is no development fleet (development turns run in
 * their Durable Objects).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { stackState } from "./src/state.ts";
import { turnBoxUserData } from "./src/turn-box-user-data.ts";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(repository, path), "utf8");

/** The names the edge, the boxes and the existing fleet already use. */
export const FLEET = {
	role: "ytimesy-box",
	group: "ytimesy-turn-box",
	// The template fleet.py made carries no Alchemy ownership tags, and
	// LaunchTemplate refuses an untagged one even with --adopt, so Alchemy
	// owns a new template and the adopted group switches to it. Running
	// boxes keep running; new boxes launch from this one.
	template: "ytimesy-turn-box-alchemy",
	logGroup: "/ytimesy/box",
	edgeUrl: "https://edge.ytimesy.com",
	instanceType: "t3.small",
	minSize: 2,
	maxSize: 6,
} as const;

const tags = { ytimesy: "turn-box" };

/**
 * The default VPC's default-for-AZ subnets, as fleet.py used: read at plan
 * time, so no account identifier is kept in the repository.
 */
const defaultSubnetIds = Effect.gen(function* () {
	const { Vpcs } = yield* ec2.describeVpcs({ Filters: [{ Name: "isDefault", Values: ["true"] }] });
	const vpcId = Vpcs?.[0]?.VpcId;
	if (!vpcId) return yield* Effect.die(new Error("The region has no default VPC."));
	const { Subnets } = yield* ec2.describeSubnets({
		Filters: [
			{ Name: "vpc-id", Values: [vpcId] },
			{ Name: "default-for-az", Values: ["true"] },
		],
	});
	const ids = (Subnets ?? [])
		.map((subnet) => subnet.SubnetId)
		.filter((id): id is `subnet-${string}` => id?.startsWith("subnet-") ?? false)
		.sort();
	if (ids.length === 0) return yield* Effect.die(new Error("The default VPC has no default subnets."));
	return ids;
}).pipe(Effect.orDie);

export default Alchemy.Stack(
	"ytimesy-aws",
	{ providers: AWS.providers(), state: stackState() },
	Effect.gen(function* () {
		const role = yield* AWS.IAM.Role("BoxRole", {
			roleName: FLEET.role,
			description: "Turn runner box: CloudWatch logs only (enrollment signs STS GetCallerIdentity, which needs no permission)",
			assumeRolePolicyDocument: {
				Version: "2012-10-17",
				Statement: [
					{
						Effect: "Allow",
						Principal: { Service: "ec2.amazonaws.com" },
						Action: ["sts:AssumeRole"],
					},
				],
			},
			managedPolicyArns: ["arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"],
			tags,
		}).pipe(RemovalPolicy.protect());

		const profile = yield* AWS.IAM.InstanceProfile("BoxProfile", {
			instanceProfileName: FLEET.role,
			roleName: role.roleName,
			tags,
		}).pipe(RemovalPolicy.protect());

		const vpc = AWS.EC2.Vpc.lookup({ isDefault: true });
		const group = yield* AWS.EC2.SecurityGroup("BoxSecurityGroup", {
			vpcId: vpc.vpcId,
			groupName: FLEET.group,
			description: "Turn runner box: no inbound rules",
			ingress: [],
			// egress omitted: the default allow-all outbound rule (the box
			// calls the edge, R2, nodejs.org and CloudWatch).
			tags,
		}).pipe(RemovalPolicy.protect());

		yield* AWS.Logs.LogGroup("BoxLogs", {
			logGroupName: FLEET.logGroup,
			retention: "14 days",
			tags,
		}).pipe(RemovalPolicy.retain());

		const template = yield* AWS.AutoScaling.LaunchTemplate("BoxTemplate", {
			launchTemplateName: FLEET.template,
			imageId: AWS.EC2.ubuntu2404(),
			instanceType: FLEET.instanceType,
			securityGroupIds: [group.groupId],
			instanceProfileName: profile.instanceProfileName,
			userData: turnBoxUserData({
				bootstrap: read("infra/turn-box/bootstrap.sh"),
				sigv4: read("infra/turn-box/sigv4.mjs"),
				start: read("infra/turn-box/start.mjs"),
				edgeUrl: FLEET.edgeUrl,
				logGroup: FLEET.logGroup,
			}),
			metadataOptions: { httpTokens: "required", httpEndpoint: "enabled", httpPutResponseHopLimit: 1 },
			// patches/@alchemy.run__aws: passed through to EC2 as-is.
			blockDeviceMappings: [
				{ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 20, VolumeType: "gp3", DeleteOnTermination: true } },
			],
			tags: { ...tags, Name: FLEET.group },
		}).pipe(RemovalPolicy.retain());

		const subnetIds = yield* defaultSubnetIds;

		const fleet = yield* AWS.AutoScaling.AutoScalingGroup("BoxFleet", {
			autoScalingGroupName: FLEET.group,
			launchTemplate: template,
			subnetIds,
			minSize: FLEET.minSize,
			maxSize: FLEET.maxSize,
			healthCheckType: "EC2",
			healthCheckGracePeriod: "5 minutes",
			tags,
		}).pipe(RemovalPolicy.protect());

		// Grow under load instead of staying at the minimum.
		yield* AWS.AutoScaling.ScalingPolicy("BoxCpu", {
			policyName: "ytimesy-turn-box-cpu",
			autoScalingGroup: fleet,
			predefinedMetricType: "ASGAverageCPUUtilization",
			targetValue: 60,
			estimatedInstanceWarmup: "3 minutes",
		});

		// A box that fails its EC2 status checks (the group replaces it, but a
		// repeating failure means the launch template or the image is broken).
		yield* AWS.CloudWatch.Alarm("BoxStatusCheck", {
			name: "ytimesy-turn-box-status-check",
			AlarmDescription: "A turn box failed its EC2 status check for 5 minutes",
			Namespace: "AWS/EC2",
			MetricName: "StatusCheckFailed",
			Dimensions: [{ Name: "AutoScalingGroupName", Value: fleet.autoScalingGroupName }],
			Statistic: "Maximum",
			Period: 60,
			EvaluationPeriods: 5,
			Threshold: 1,
			ComparisonOperator: "GreaterThanOrEqualToThreshold",
			TreatMissingData: "notBreaching",
			tags,
		});

		// The whole fleet pinned on CPU: scaling is at its maximum or a turn loops.
		yield* AWS.CloudWatch.Alarm("BoxCpuHigh", {
			name: "ytimesy-turn-box-cpu-high",
			AlarmDescription: "Turn box fleet CPU above 85% for 15 minutes",
			Namespace: "AWS/EC2",
			MetricName: "CPUUtilization",
			Dimensions: [{ Name: "AutoScalingGroupName", Value: fleet.autoScalingGroupName }],
			Statistic: "Average",
			Period: 300,
			EvaluationPeriods: 3,
			Threshold: 85,
			ComparisonOperator: "GreaterThanThreshold",
			TreatMissingData: "notBreaching",
			tags,
		});

		return {
			group: fleet.autoScalingGroupName,
			template: template.launchTemplateName,
			role: role.roleArn,
		};
	}),
);