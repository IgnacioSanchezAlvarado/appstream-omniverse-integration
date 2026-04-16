 # Configuration

  [← Back to README](../README.md)

  All settings controlled via `config.json`:

  ### Project
  - `projectName` — Used to derive resource names: fleet (`{name}-fleet`), stack (`{name}-stack`), IAM roles, S3 buckets, etc.
  - `region` — AWS region (default: eu-central-1)
  - `tags.Project` / `tags.Environment` — Tags applied to all resources

  ### Fleet
  - `fleet.instanceType` — GPU instance type (default: Accelerated.g6e.xlarge)
  - `fleet.instanceTypeFallback` — Fallback instance type if primary is unavailable
  - `fleet.fleetType` — `ON_DEMAND` or `ALWAYS_ON` (default: ON_DEMAND)
  - `fleet.minCapacity` / `fleet.maxCapacity` — Fleet scaling limits (default: 0/1)
  - `fleet.streamingProtocol` — Streaming protocol (default: NICE_DCV)

  ### Image
  - `image.customImageName` — AppStream image name (set automatically by `prepare-ami.py`)
  - `image.baseAmiId` — Pinned Windows Server 2022 AMI ID for image building. Auto-validated at runtime; if not found in the target region, falls back to SSM parameter lookup automatically. Pin to a known-good AMI version to avoid breakage from Windows updates
  - `image.baseAmiParameter` — SSM parameter path for latest Windows AMI. Only used when `baseAmiId` is empty
  - `image.marketplaceAmiId` — Omniverse marketplace AMI ID. Not used by default (product codes block AppStream import)

  ### AMI Builder
  - `amiBuilder.instanceTypes` — G6e instance types tried in order for AMI creation
  - `amiBuilder.gridDriverS3Path` — S3 path for NVIDIA GRID driver download (default: `s3://ec2-windows-nvidia-drivers/grid-19.4/`). Pin to a specific
  version to avoid breakage from driver updates
  - `amiBuilder.gridDriverVersion` — GRID driver version for documentation (e.g., `582.16`). Informational only — the actual version is determined by
  `gridDriverS3Path`

  ### Monitoring
  - `monitoring.dashboardEnabled` — Deploy the web dashboard (S3 + CloudFront). Set to `false` to skip dashboard deployment; the metrics API remains
  available via CLI regardless
  - `monitoring.metricsRetentionDays` — CloudWatch log retention in days (default: 7)
  - `monitoring.cloudWatchNamespace` — CloudWatch namespace for AppStream metrics (default: AWS/AppStream)
  - `monitoring.metricsToDisplay` — Metrics shown in the dashboard (default: InSessionLatency, FramesPerSecond, Bandwidth, CpuUtilizationInstance)

  ### Dashboard
  - `dashboard.adminEmail` — Email address for the initial Cognito admin user. **Must be changed** from the default placeholder before deploying

  ### Omniverse
  - `omniverse.kitAppTemplateRepo` — Git repo URL for Kit App Template (cloned during AMI build)

  ### Nucleus
  - `nucleus.enabled` — Deploy Nucleus server for USD asset storage and collaboration (default: true)
  - `nucleus.metricsEnabled` — Deploy Nucleus monitoring (API latency, CPU, memory) to dashboard
  - `nucleus.instanceType` — EC2 instance type for Nucleus (default: c5.2xlarge)
  - `nucleus.storageSize` — EBS volume size in GB for Nucleus data (default: 512)
  - `nucleus.nucleusBuild` — Nucleus stack version to download and deploy

  Review and modify as needed before deployment.
