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

### Request Service Quotas (Do This First)

AppStream GPU instance quotas default to 0. You'll need to request quota increases for:
- **Image builder quota** (L-472DE3D3): minimum 1
- **Fleet instance quota** (L-2C3EA73C): minimum 1

See AWS documentation for requesting quota increases: https://docs.aws.amazon.com/appstream2/latest/developerguide/service-quotas.html

Approval typically takes 1-2 business days. Wait for both quotas to be approved before proceeding.

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
- S3 bucket + CloudFront distribution for dashboard (optional, see Configuration)
- IAM role for AppStream image import

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

### Step 3: Deploy Fleet

```bash
cd infra && cdk deploy
```

Now that `config.json` has the image name set, this deploys:
- AppStream fleet (STOPPED state by default)
- AppStream stack

After deployment, start the fleet and set desired capacity to 1. You can do this via the [AppStream console](https://docs.aws.amazon.com/appstream2/latest/developerguide/set-up-stacks-fleets.html) or the [AWS CLI](https://docs.aws.amazon.com/cli/latest/reference/appstream/start-fleet.html). The fleet takes 10-15 minutes to reach RUNNING state.

## Test It

### Create a Streaming Session

Once the fleet is RUNNING, create a streaming URL via the AppStream console or AWS CLI:
- **Console**: https://docs.aws.amazon.com/appstream2/latest/developerguide/set-up-stacks-fleets.html
- **CLI**: https://docs.aws.amazon.com/cli/latest/reference/appstream/create-streaming-url.html

Open the streaming URL in a browser to start a session.

### Verify GPU Acceleration

In the streaming session:
- Open a command prompt and run `nvidia-smi` — should show an NVIDIA L40S GPU (Ada Lovelace architecture)
- Launch the Omniverse Kit application and verify 3D rendering works smoothly

### View Metrics Dashboard (Optional)

If the dashboard is enabled (`monitoring.dashboardEnabled: true` in `config.json`), access it via the `DashboardUrl` from CDK outputs. Authentication is automatic — no manual configuration needed.

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
- `image.marketplaceAmiId` — Source marketplace AMI for image preparation
- `monitoring.dashboardEnabled` — Deploy the web dashboard (S3 + CloudFront). Set to `false` to skip dashboard deployment; the metrics API remains available via CLI regardless

Review and modify as needed before deployment.

## Troubleshooting

### Manual Image Build Alternative

If `prepare-ami.py` fails (e.g., InsufficientInstanceCapacity errors):

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

### Service Role Missing

If fleet deployment fails with "Internal Failure", the AppStream service role may be missing:

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

### Other Common Issues

**`prepare-ami.py` fails with InsufficientInstanceCapacity**
- G6e capacity exhausted in selected AZ. Try different AZ or use manual alternative above.

**Metrics not appearing in dashboard**
- Ensure you've created an active streaming session
- Wait 2-3 minutes for CloudWatch metrics to propagate
- Verify metrics in CLI using the test commands above

**Dashboard shows "Failed to fetch sessions"**
- Check API Gateway logs in CloudWatch (`/aws/lambda/metrics-collector-lambda`)
- Verify fleet is RUNNING and has active or recent sessions
