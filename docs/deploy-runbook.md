# Deploy runbook

[← Back to README](../README.md)

One document from quota request to clean up, for the owner deploying this POC by hand. The commands are the same as in the [README](../README.md), in the same order, with the waits and checks written out. Nobody but the owner runs them: the demo platform never deploys, starts or destroys this project, and the hub's Start/Stop control only drives the fleet described in `launcher.json` once the deploy below is done.

Everything happens in **eu-central-1**, the region set in `config.json`. Every command below carries `--region eu-central-1`; if your AWS CLI default region is different, keep the flag.

Reference pages used along the way (linked, not repeated here):

- [Configuration reference](configuration.md) — every `config.json` key
- [Nucleus guide](nucleus.md) — admin credentials, users, session features
- [Troubleshooting](troubleshooting.md) — manual image build, missing service role, metrics checks
- [Launcher setup](launcher-setup.md) — how to fill the `launcher.json` placeholders after the deploy

## Overview

| Step | What | Wait |
|------|------|------|
| 1 | Request the two AppStream GPU quotas | 1 to 2 business days |
| 2 | Prerequisites and `config.json` | minutes |
| 3 | First `cdk deploy` (VPC, API, dashboard, image import role) | 10 to 15 minutes |
| 4 | Build the AppStream image with `prepare-ami.py` | 30 to 45 minutes |
| 5 | Second `cdk deploy` (fleet and stack, created stopped) | 5 to 10 minutes |
| 6 | Start the fleet | 10 to 15 minutes to RUNNING |
| 7 | Test it (streaming URL, `nvidia-smi`, dashboard) | minutes |
| 8 | Fill the `launcher.json` placeholders | minutes |
| 9 | Clean up | fleet stop, then `cdk destroy` |

## Step 1: Request service quotas (do this first)

AppStream GPU quotas default to 0 in every account. Request both increases in **eu-central-1** before doing anything else, because nothing after this step works without them:

| Quota code | Quota | Request at least |
|------------|-------|------------------|
| `L-472DE3D3` | Image builder instances (g6e family) | 1 |
| `L-2C3EA73C` | Fleet instances (g6e family) | 1 |

Request them through the Service Quotas console in eu-central-1 or with the CLI:

```bash
aws service-quotas request-service-quota-increase \
  --service-code appstream2 \
  --quota-code L-472DE3D3 \
  --desired-value 1 \
  --region eu-central-1

aws service-quotas request-service-quota-increase \
  --service-code appstream2 \
  --quota-code L-2C3EA73C \
  --desired-value 1 \
  --region eu-central-1
```

Approval typically takes **1 to 2 business days**. Wait for both quotas to be approved before continuing. Check with:

```bash
aws service-quotas list-requested-service-quota-change-history \
  --service-code appstream2 \
  --region eu-central-1
```

AWS documentation: [AppStream 2.0 service quotas](https://docs.aws.amazon.com/appstream2/latest/developerguide/service-quotas.html).

## Step 2: Prerequisites

On the machine you deploy from:

- AWS account with AppStream 2.0 service enabled, and credentials for it configured in AWS CLI v2
- Node.js 18+ and npm
- Python 3.12+ and boto3
- CDK CLI: `npm install -g aws-cdk`

Clone the repository and prepare `config.json`. The deployed values (image name, fleet sizing) live in `config.json`, which is not tracked in git; the tracked template is `config.example.json`.

**If `config.json` is missing**, create it from the example:

```bash
cp config.example.json config.json
```

Then review it against the [configuration reference](configuration.md). For a first deploy:

- `region` stays `eu-central-1`.
- `image.customImageName` must be **empty** (`""`). The stack only creates the fleet when this value is set, and step 4 fills it in for you. If it already holds an image name from an earlier deploy that no longer exists, clear it.
- `nucleus.enabled` decides whether the optional Nucleus server (EC2 + EBS + a Secrets Manager secret) is deployed. Leave it `false` unless you want multi-user collaboration; see the [Nucleus guide](nucleus.md).
- `monitoring.dashboardEnabled: true` deploys the metrics dashboard used by the hub. Keep it on.

## Step 3: Deploy the base infrastructure

```bash
cd infra && npm install
cdk bootstrap  # first time only
cdk deploy
```

Deploys the VPC with private subnets, API Gateway + Lambda for metrics, S3 + CloudFront for the dashboard, and the IAM role AppStream uses to import the image. With `nucleus.enabled: true` it also deploys the Nucleus EC2 instance. No fleet is created yet because `image.customImageName` is empty; the output `FleetEnabled` reads `false`.

Note the outputs `ImageImportRoleArn` and `DashboardUrl`; step 4 uses the role automatically and step 7 opens the dashboard.

If the deploy fails with "Internal Failure", the AppStream service role may be missing in the account: see [Service role missing](troubleshooting.md#service-role-missing).

## Step 4: Build the AppStream image

From the repository root:

```bash
python scripts/prepare-ami.py
```

The script launches a G6e instance from the Omniverse marketplace AMI, installs the GRID drivers, creates an AMI snapshot, imports it into AppStream with g6e runtime validation, and **writes the resulting image name into `config.json`** (`image.customImageName`). It takes **30 to 45 minutes**; leave it running.

If it fails with `InsufficientInstanceCapacity`, G6e capacity is exhausted in the chosen availability zone. Retry later, or follow the [manual image build alternative](troubleshooting.md#manual-image-build-alternative) and set `image.customImageName` by hand.

Confirm before moving on:

```bash
aws appstream describe-images \
  --names "$(python -c "import json; print(json.load(open('config.json'))['image']['customImageName'])")" \
  --region eu-central-1 \
  --query 'Images[0].State'
```

The image must be `AVAILABLE`.

## Step 5: Deploy the fleet

Now that `config.json` names an image, the same deploy command adds the fleet and the AppStream stack:

```bash
cd infra && cdk deploy
```

The fleet `appstream-omniverse-fleet` is created **STOPPED with zero instances** (`fleet.minCapacity` is 0, so `DesiredInstances` is 0). The AppStream stack `appstream-omniverse-stack` is associated with it. Nothing bills for GPU time until step 6. The outputs `FleetName` and `AppStreamStackName` confirm the names.

## Step 6: Start the fleet

This is what the hub's Start button does through the demo launcher. Done by hand:

```bash
aws appstream update-fleet \
  --name appstream-omniverse-fleet \
  --compute-capacity DesiredInstances=1 \
  --region eu-central-1

aws appstream start-fleet \
  --name appstream-omniverse-fleet \
  --region eu-central-1
```

Then poll the state until it reads `RUNNING`, which takes **10 to 15 minutes**:

```bash
aws appstream describe-fleets \
  --names appstream-omniverse-fleet \
  --region eu-central-1 \
  --query 'Fleets[0].[State,ComputeCapacityStatus.Desired,ComputeCapacityStatus.Available]'
```

`Available` reaching 1 means an instance is ready for a session. The console equivalent is documented at [Set up stacks and fleets](https://docs.aws.amazon.com/appstream2/latest/developerguide/set-up-stacks-fleets.html).

If Nucleus is enabled, also start its EC2 instance (`NucleusInstanceId` output) so the session's saved server is reachable:

```bash
aws ec2 start-instances --instance-ids <NucleusInstanceId> --region eu-central-1
```

## Step 7: Test it

### Create a streaming session

Streaming URLs are created per session against the AppStream stack and expire, which is why the hub links to the dashboard and not to a session. Create one:

```bash
aws appstream create-streaming-url \
  --stack-name appstream-omniverse-stack \
  --fleet-name appstream-omniverse-fleet \
  --user-id demo-user \
  --region eu-central-1 \
  --query StreamingURL --output text
```

Open the returned URL in a browser to start the session. Console alternative: [AppStream console](https://docs.aws.amazon.com/appstream2/latest/developerguide/set-up-stacks-fleets.html); CLI reference: [create-streaming-url](https://docs.aws.amazon.com/cli/latest/reference/appstream/create-streaming-url.html).

### Verify GPU acceleration

In the streaming session:

- Open a command prompt and run `nvidia-smi`. It should show an **NVIDIA L40S** GPU (Ada Lovelace).
- The [Kit App Template](https://github.com/NVIDIA-Omniverse/kit-app-template) is pre-installed at `C:\Omniverse\kit-app-template` with a desktop shortcut.
- With Nucleus enabled, the **Nucleus Navigator** shortcut and `nucleus-info.txt` are on the desktop; admin credentials and user creation are in the [Nucleus guide](nucleus.md).

### View the metrics dashboard

Open the `DashboardUrl` output from the CDK deploy. Metrics (FPS, latency, bandwidth, CPU) appear 2 to 3 minutes after a session is active. If the dashboard stays empty or shows "Failed to fetch sessions", follow [Troubleshooting](troubleshooting.md#other-common-issues) and the [CLI metrics check](troubleshooting.md#cli-metrics-check).

To read the outputs again later:

```bash
aws cloudformation describe-stacks \
  --stack-name AppStreamOmniverseStack \
  --region eu-central-1 \
  --query 'Stacks[0].Outputs'
```

## Step 8: Fill the launcher placeholders

`launcher.json` at the repository root tells the demo launcher how to start and stop this demo from the hub. Values that exist only after your deploy are placeholders: the dashboard URL (`DashboardUrl`), the Nucleus instance id (`NucleusInstanceId`, only when `nucleus.enabled` is true) and the hourly cost of one `Accelerated.g6e.xlarge` instance from the AppStream pricing page.

Follow [Launcher setup](launcher-setup.md), which lists each placeholder with the read-only command or console page that reveals it, then commit `launcher.json`. From then on the hub card shows the fleet state and its Start/Stop control replaces step 6 and the stop command below; the launcher also stops the demo after 120 minutes if you forget.

## Stop between meetings

The fleet bills per instance-hour while RUNNING. Stop it when you are done (the hub's Stop button does the same):

```bash
aws appstream update-fleet \
  --name appstream-omniverse-fleet \
  --compute-capacity DesiredInstances=0 \
  --region eu-central-1

aws appstream stop-fleet \
  --name appstream-omniverse-fleet \
  --region eu-central-1
```

With Nucleus enabled, stop its instance too:

```bash
aws ec2 stop-instances --instance-ids <NucleusInstanceId> --region eu-central-1
```

## Step 9: Clean up

1. **Stop the fleet** to avoid charges:

   ```bash
   aws appstream stop-fleet \
     --name appstream-omniverse-fleet \
     --region eu-central-1
   ```

   Wait until `describe-fleets` (step 6) reports `STOPPED`; CloudFormation cannot delete a running fleet.

2. **Destroy the infrastructure:**

   ```bash
   cd infra && cdk destroy
   ```

   This removes the fleet, the AppStream stack, the VPC, the API, the dashboard bucket and distribution, and, when Nucleus is enabled, its EC2 instance and EBS volume.

3. **Secrets Manager (Nucleus only).** The Nucleus admin secret `appstream-omniverse/nucleus/admin` enters a **7-day deletion window** rather than disappearing at once. Delete it immediately via the console if you need the name free, or if you plan to redeploy with Nucleus within the week.

4. **Manually delete what the stack never owned** (via the AWS Console, region eu-central-1):

   | Resource | Where |
   |----------|-------|
   | AppStream image (name from `image.customImageName`) | AppStream 2.0 > Images |
   | Prepared AMI created by `prepare-ami.py` | EC2 > AMIs |
   | The AMI's EBS snapshot | EC2 > Snapshots (deregister the AMI first) |

5. Clear `image.customImageName` in `config.json` if you keep the file, so the next first deploy does not reference a deleted image.

## Known security gaps

Accepted for this POC and documented, not fixed, in this project. The hub page shows the same table.

| Gap | Where | Why accepted for a POC |
|-----|-------|------------------------|
| No AWS WAF on the CloudFront distribution | Metrics dashboard (S3 + CloudFront, `DashboardUrl`) | The dashboard is a static page that only renders metrics; the data comes from the API below. WAF adds cost and rules to maintain for a demo that runs a few hours at a time. |
| Nucleus reached over plain HTTP on port 8080 | Nucleus web UI and API inside the VPC, reachable only from the AppStream fleet security group and the metrics Lambda | Nucleus has no public endpoint; traffic stays inside private subnets between the fleet and the instance. TLS would require certificates and a hostname the POC does not have. Production guidance in the [Nucleus guide](nucleus.md). |
| API key authentication on the metrics API | API Gateway + Lambda (`ApiUrl`, `ApiKeyValue` outputs) | The API only reads AppStream CloudWatch metrics and session lists; it cannot start or stop anything. An API key was the simplest gate for a demo. Production would use IAM or Cognito authorizers. |

Also worth knowing, though not listed as gaps: the fleet instances sit in private subnets and are reached only through the AppStream streaming gateway; `create-streaming-url` links expire and need AWS credentials to create; the platform hub itself sits behind the platform's Cognito user pool.
