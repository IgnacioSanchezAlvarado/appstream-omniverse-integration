# AppStream Omniverse POC

AWS AppStream 2.0 streaming NVIDIA Omniverse Kit applications with GPU acceleration (G6e instances, NVIDIA L40S GPUs). Includes a metrics dashboard showing real-time FPS, latency, bandwidth, and CPU utilization from AppStream's built-in CloudWatch metrics.

## Architecture

**VPC with private subnets** → **AppStream fleet (G6e GPU instances)** → **CloudFront dashboard**

Infrastructure deployed via AWS CDK (TypeScript):
- **Backend**: Lambda functions (`metrics-collector`, `session-manager`) serve AppStream metrics via API Gateway with API key authentication
- **Frontend**: React + Vite dashboard (Chart.js) hosted on S3 + CloudFront
- **Metrics**: AppStream built-in CloudWatch metrics (FPS, latency, bandwidth, CPU) — no custom instrumentation required

## Prerequisites

- AWS account with AppStream 2.0 service enabled
- AWS CLI v2 configured with appropriate credentials
- Node.js 18+ and npm
- Python 3.12+ and boto3
- CDK CLI: `npm install -g aws-cdk`
- **Service quotas approved** for g6e instance types in AppStream:
  - Image builder quota (L-472DE3D3): minimum 1
  - Fleet instance quota (L-2C3EA73C): minimum 5
- **NVIDIA Omniverse Developer Kit marketplace subscription**: [Subscribe here](https://aws.amazon.com/marketplace/pp/prodview-ndixrws36jsni)
  - AMI ID: `ami-07bafd3ee37eb865e` (eu-central-1)

### Request Service Quotas (Do This First)

AppStream GPU instance quotas default to 0. Request increases before deploying:

```bash
# Image builder quota (needed for image import with runtime validation)
aws service-quotas request-service-quota-increase \
  --service-code appstream2 \
  --quota-code L-472DE3D3 \
  --desired-value 1 \
  --region eu-central-1

# Fleet instance quota
aws service-quotas request-service-quota-increase \
  --service-code appstream2 \
  --quota-code L-2C3EA73C \
  --desired-value 5 \
  --region eu-central-1
```

Check approval status:

```bash
aws service-quotas list-requested-service-quota-change-history \
  --service-code appstream2 --region eu-central-1 \
  --query "RequestedQuotas[*].[QuotaName,Status,DesiredValue]" --output table
```

**Wait for both quotas to be approved before proceeding.** Approval typically takes 1-2 business days.

## Deploy

### Step 1: Deploy Base Infrastructure

```bash
cd infra && npm install
cdk bootstrap  # first time only
cdk deploy
```

This deploys:
- VPC with private subnets
- API Gateway + Lambda functions for metrics API
- S3 bucket + CloudFront distribution for dashboard
- IAM role for AppStream image import

**Note these CDK outputs** — you'll need them later:
- `ImageImportRoleArn` — required for Step 2 (image import)
- `DashboardUrl` — dashboard URL (after Step 3)
- `ApiKeyValue` — API key for dashboard authentication (stored in runtime-config.json)

The fleet is NOT created yet (no image configured in `config.json`).

### Step 2: Build AppStream Image

```bash
python scripts/prepare-ami.py
```

This script:
1. Launches a G6e EC2 instance from the Omniverse marketplace AMI
2. Installs GRID drivers and AppStream prerequisites via userdata
3. Waits for the instance to be ready
4. Creates an AMI snapshot
5. Imports the AMI into AppStream with g6e runtime validation
6. Waits for AppStream import to complete (~30-60 minutes)
7. Automatically updates `config.json` with the new image name

**Total time:** ~30-45 minutes

**Options:**
- `--skip-appstream-import` — Only create the AMI, skip AppStream import (you'll need to manually import)
- `--testing` — Keep EC2 instance running for manual inspection instead of terminating

**Manual Alternative:**

If the script fails (e.g., InsufficientInstanceCapacity errors):

1. Launch a g6e.xlarge instance from the Omniverse marketplace AMI in AWS Console
2. Connect via RDP/SSM and verify Omniverse and `nvidia-smi` work
3. Stop the instance, create an AMI (Actions > Image and templates > Create image)
4. Import into AppStream:
   ```bash
   aws appstream create-imported-image \
     --name omniverse \
     --source-ami-id <your-ami-id> \
     --iam-role-arn <ImageImportRoleArn-from-step-1> \
     --description "Omniverse Developer Kit with GRID drivers for G6e" \
     --agent-software-version ALWAYS_LATEST \
     --runtime-validation-config IntendedInstanceType=Accelerated.g6e.xlarge \
     --region eu-central-1
   ```
5. Wait for import to complete, then manually update `config.json` with the image name

### Step 3: Deploy Fleet

```bash
cd infra && cdk deploy
```

Now that `config.json` has the image name set, this deploys:
- AppStream fleet (STOPPED state by default)
- AppStream stack

**If deployment fails with "Internal Failure"**, the AppStream service role may be missing:

```bash
# Create service role (only needed once per account)
aws iam create-role \
  --role-name AmazonAppStreamServiceAccess \
  --path /service-role/ \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "appstream.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name AmazonAppStreamServiceAccess \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonAppStreamServiceAccess

# Retry deployment
cd infra && cdk deploy
```

After deployment, **start the fleet**:

```bash
# Set desired capacity and start
aws appstream update-fleet \
  --name appstream-omniverse-fleet \
  --compute-capacity DesiredInstances=1 \
  --region eu-central-1

aws appstream start-fleet \
  --name appstream-omniverse-fleet \
  --region eu-central-1
```

Wait for fleet to reach RUNNING state (10-15 minutes):

```bash
aws appstream describe-fleets \
  --names appstream-omniverse-fleet \
  --region eu-central-1 \
  --query "Fleets[0].State" --output text
```

## Test It

### Create a Streaming Session

Once the fleet is RUNNING:

```bash
aws appstream create-streaming-url \
  --stack-name appstream-omniverse-stack \
  --fleet-name appstream-omniverse-fleet \
  --user-id test@example.com \
  --validity 60 \
  --region eu-central-1
```

Open the returned `StreamingURL` in a browser to start a streaming session.

### Verify GPU Acceleration

In the streaming session:
- Open a command prompt and run `nvidia-smi` — should show an NVIDIA L40S GPU (Ada Lovelace architecture)
- Launch the Omniverse Kit application and verify 3D rendering works smoothly

### View Metrics Dashboard

Access the dashboard via the `DashboardUrl` from CDK outputs (CloudFront URL).

**Authentication**: The dashboard automatically uses the API key from `runtime-config.json` (injected during deployment). No manual configuration needed.

The dashboard displays:
- **FPS** — Frames per second delivered to the streaming client
- **Latency** — Round-trip time between server and client (milliseconds)
- **Bandwidth** — Network throughput (kilobits/second)
- **CPU Utilization** — Instance CPU usage (percent)

All metrics are automatically collected by AppStream and published to CloudWatch (no custom instrumentation required). The dashboard auto-refreshes every 30 seconds.

### CLI Metrics Check

Verify metrics appear in CloudWatch:

```bash
for metric in InSessionLatency FramesPerSecond Bandwidth CpuUtilizationInstance; do
  echo "=== $metric ==="
  aws cloudwatch get-metric-statistics \
    --namespace AWS/AppStream \
    --metric-name $metric \
    --dimensions Name=Fleet,Value=appstream-omniverse-fleet \
    --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S) \
    --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
    --period 60 \
    --statistics Average,Maximum,Minimum \
    --region eu-central-1
done
```

## Clean Up

Stop the fleet to avoid charges:

```bash
aws appstream stop-fleet \
  --name appstream-omniverse-fleet \
  --region eu-central-1
```

Wait for fleet to stop, then destroy infrastructure:

```bash
cd infra && cdk destroy
```

Manually delete (via AWS Console):
- AppStream image: AppStream 2.0 > Images
- Prepared AMI: EC2 > AMIs
- Associated EBS snapshot: EC2 > Snapshots

## Configuration

All settings controlled via `config.json`:
- `region` — AWS region (default: eu-central-1)
- `fleet.instanceType` — GPU instance type (default: Accelerated.g6e.xlarge)
- `fleet.minCapacity` / `fleet.maxCapacity` — Fleet scaling limits
- `image.customImageName` — AppStream image name (set automatically by `prepare-ami.py` script)
- `image.marketplaceAmiId` — Source marketplace AMI for image preparation (default: `ami-07bafd3ee37eb865e`)

Review and modify as needed before deployment.

## Troubleshooting

**Fleet deployment fails with "Internal Failure"**
- Missing AppStream service role. See Step 3 deployment instructions to create it.

**`prepare-ami.py` fails with InsufficientInstanceCapacity**
- G6e capacity exhausted in selected AZ. Try different AZ or use manual alternative in Step 2.

**Metrics not appearing in dashboard**
- Ensure you've created an active streaming session
- Wait 2-3 minutes for CloudWatch metrics to propagate
- Verify metrics in CLI using the test commands in "CLI Metrics Check" section

**Dashboard shows "Failed to fetch sessions"**
- Check API Gateway logs in CloudWatch (`/aws/lambda/metrics-collector-lambda`)
- Verify fleet is RUNNING and has active or recent sessions
