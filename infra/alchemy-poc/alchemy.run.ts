/**
 * PROOF OF CONCEPT, NEVER APPLIED. The turn box fleet as an Alchemy v2 stack:
 * what infra/turn-box/fleet.py and the hand-made IAM role do today, plus the
 * CloudWatch alarms and target-tracking scaling that do not exist yet.
 * See docs/alchemy-assessment.md for the adoption plan before running anything.
 *
 *   ALCHEMY_STAGE=prod pnpm --dir infra/alchemy-poc exec alchemy plan     # read-only diff
 *
 * Kept in its own package because Alchemy v2 needs Effect 4 and the app pins
 * Effect 3. Type-checked against alchemy/@alchemy.run/aws 2.0.0-beta.87.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

const box = join(dirname(fileURLToPath(import.meta.url)), "..", "turn-box");
const read = (name: string) => readFileSync(join(box, name), "utf8").replace(/\n$/, "");

/** The same user data fleet.py builds: bootstrap.sh with its placeholders filled. */
const userData = Object.entries({
	__SIGV4_MJS__: read("sigv4.mjs"),
	__START_MJS__: read("start.mjs"),
	__EDGE_URL__: "https://edge.ytimesy.com",
	__LOG_GROUP__: "/ytimesy/box",
}).reduce((script, [from, to]) => script.split(from).join(to), read("bootstrap.sh"));
if (Buffer.byteLength(userData) >= 16_000) throw new Error("user data would exceed 16 KB");

const tags = { ytimesy: "turn-box" };

export default Alchemy.Stack(
	"ytimesy-turn-box",
	{ providers: AWS.providers(), state: AWS.state() },
	Effect.gen(function* () {
		// The role the edge's enrollment check expects by name (TURN_BOX_AWS_ROLE,
		// default ytimesy-box): renaming it would break every box's enrollment.
		const role = yield* AWS.IAM.Role("BoxRole", {
			roleName: "ytimesy-box",
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
			// Logs only. The box has no other AWS permission: it signs STS
			// GetCallerIdentity, which needs none.
			managedPolicyArns: ["arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"],
			tags,
		}).pipe(RemovalPolicy.protect());
		const profile = yield* AWS.IAM.InstanceProfile("BoxProfile", {
			instanceProfileName: "ytimesy-box",
			roleName: role.roleName,
			tags,
		}).pipe(RemovalPolicy.protect());

		const vpc = AWS.EC2.Vpc.lookup({ isDefault: true });
		// The default-for-AZ subnets fleet.py uses, by id (kept out of the repo,
		// like the other production identifiers).
		const subnetIds = (process.env.TURN_BOX_SUBNET_IDS ?? "")
			.split(",")
			.filter((id): id is `subnet-${string}` => id.startsWith("subnet-"));
		if (subnetIds.length === 0) throw new Error("Set TURN_BOX_SUBNET_IDS (comma-separated).");
		const group = yield* AWS.EC2.SecurityGroup("BoxGroup", {
			vpcId: vpc.vpcId,
			groupName: "ytimesy-turn-box",
			description: "Turn runner box: no inbound rules",
			ingress: [],
			tags,
		}).pipe(RemovalPolicy.retain());

		yield* AWS.Logs.LogGroup("BoxLogs", {
			logGroupName: "/ytimesy/box",
			retention: "14 days",
			tags,
		}).pipe(RemovalPolicy.retain());

		// A new name on purpose: the template fleet.py made carries no alchemy
		// ownership tags, and LaunchTemplate refuses it even with --adopt.
		// The adopted group switches to this one; running boxes are untouched.
		const template = yield* AWS.AutoScaling.LaunchTemplate("BoxTemplate", {
			launchTemplateName: "ytimesy-turn-box-alchemy",
			imageId: AWS.EC2.ubuntu2404(),
			instanceType: "t3.small",
			securityGroupIds: [group.groupId],
			instanceProfileName: profile.instanceProfileName,
			userData,
			metadataOptions: { httpTokens: "required", httpEndpoint: "enabled", httpPutResponseHopLimit: 1 },
			// Gap: no blockDeviceMappings in beta.87, so the root disk would be the
			// image's 8 GB instead of fleet.py's 20 GB gp3 (and the box log file has
			// no rotation). Until that exists upstream, keep fleet.py's template and
			// reference it instead: AWS.AutoScaling.LaunchTemplate.lookup({
			// launchTemplateName: "ytimesy-turn-box" }).
			tags,
		});

		const fleet = yield* AWS.AutoScaling.AutoScalingGroup("BoxFleet", {
			autoScalingGroupName: "ytimesy-turn-box",
			launchTemplate: template,
			subnetIds,
			minSize: 2,
			maxSize: 6,
			healthCheckType: "EC2",
			healthCheckGracePeriod: "5 minutes",
			tags,
		}).pipe(RemovalPolicy.protect());

		// New: grow under CPU load instead of staying at 2 boxes forever.
		yield* AWS.AutoScaling.ScalingPolicy("BoxCpu", {
			autoScalingGroup: fleet,
			predefinedMetricType: "ASGAverageCPUUtilization",
			targetValue: 60,
			estimatedInstanceWarmup: "3 minutes",
		});

		// New: page when the fleet is short of boxes (no alarm exists today).
		// Needs the group's metrics collection on (EnableMetricsCollection), which
		// AutoScalingGroup does not expose in beta.87: one hand step, or alarm on
		// the edge's own "boxes registered" signal instead. No AlarmActions yet:
		// add an SNS topic (AWS.SNS.Topic) or a webhook to the existing alerts.
		yield* AWS.CloudWatch.Alarm("BoxesInService", {
			Namespace: "AWS/AutoScaling",
			MetricName: "GroupInServiceInstances",
			Dimensions: [{ Name: "AutoScalingGroupName", Value: fleet.autoScalingGroupName }],
			Statistic: "Minimum",
			Period: 60,
			EvaluationPeriods: 5,
			Threshold: 1,
			ComparisonOperator: "LessThanThreshold",
			TreatMissingData: "breaching",
			tags,
		});

		return { group: fleet.autoScalingGroupName, template: template.launchTemplateName };
	}),
);