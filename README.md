# AppStream Omniverse POC

AWS AppStream 2.0 streaming NVIDIA Omniverse Kit applications with GPU acceleration (G6e instances, NVIDIA L40S GPUs). Includes a metrics dashboard showing real-time FPS, latency, bandwidth, and CPU utilization from AppStream's built-in CloudWatch metrics.

<table><tr>
<td><img src="images/appstream.png" alt="Omniverse Kit running in AppStream" width="400"/></td>
<td><img src="images/dashboard.png" alt="Metrics dashboard" width="400"/></td>
</tr></table>

## Architecture

![Architecture](architecture.png)

**VPC with private subnets** → **AppStream fleet (G6e GPU instances)** → **Nucleus server (optional)** → **CloudFront dashboard**

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

Deploys VPC, API Gateway + Lambda for metrics, S3 + CloudFront for dashboard, and IAM role for AppStream image import.

### Step 2: Build AppStream Image

```bash
python scripts/prepare-ami.py
```

Launches G6e instance from Omniverse marketplace AMI, installs GRID drivers, creates AMI snapshot, imports to AppStream with g6e validation, and updates `config.json`. Takes 30-45 minutes.

### Step 3: Deploy Fleet

```bash
cd infra && cdk deploy
```

Deploys AppStream fleet (STOPPED) and stack. After deployment, start the fleet and set desired capacity to 1 via [console](https://docs.aws.amazon.com/appstream2/latest/developerguide/set-up-stacks-fleets.html) or [CLI](https://docs.aws.amazon.com/cli/latest/reference/appstream/start-fleet.html). Fleet takes 10-15 minutes to reach RUNNING.

## Test It

### Create a Streaming Session

Create a streaming URL via [AppStream console](https://docs.aws.amazon.com/appstream2/latest/developerguide/set-up-stacks-fleets.html) or [AWS CLI](https://docs.aws.amazon.com/cli/latest/reference/appstream/create-streaming-url.html). Open in a browser to start a session.

### Verify GPU Acceleration

In the streaming session:
- Run `nvidia-smi` in command prompt — should show NVIDIA L40S GPU (Ada Lovelace)
- [Kit App Template](https://github.com/NVIDIA-Omniverse/kit-app-template) is pre-installed at `C:\Omniverse\kit-app-template` with desktop shortcut

> Session features (Nucleus auto-config, file persistence): see [Session Features](docs/nucleus.md)

> For Nucleus server setup and multi-user collaboration: see [Nucleus Guide](docs/nucleus.md)

### View Metrics Dashboard

If dashboard is enabled (`monitoring.dashboardEnabled: true` in `config.json`), access via `DashboardUrl` from CDK outputs.

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

**Note**: If Nucleus is enabled, the EC2 instance and EBS volume are deleted with the stack. Secrets Manager secrets enter a 7-day deletion window — delete immediately via the console if needed.

Manually delete (via AWS Console):
- AppStream image: AppStream 2.0 > Images
- Prepared AMI: EC2 > AMIs
- Associated EBS snapshot: EC2 > Snapshots

## Documentation

- [Configuration Reference](docs/configuration.md) — All config.json settings
- [Troubleshooting Guide](docs/troubleshooting.md) — Common issues and solutions
- [Nucleus Guide](docs/nucleus.md) — Multi-user collaboration setup
