# Configuration

[← Back to README](../README.md)

All settings controlled via `config.json`:
- `region` — AWS region (default: eu-central-1)
- `fleet.instanceType` — GPU instance type (default: Accelerated.g6e.xlarge)
- `fleet.minCapacity` / `fleet.maxCapacity` — Fleet scaling limits
- `image.customImageName` — AppStream image name (set automatically by `prepare-ami.py` script)
- `image.marketplaceAmiId` — Source marketplace AMI for image preparation
- `monitoring.dashboardEnabled` — Deploy the web dashboard (S3 + CloudFront). Set to `false` to skip dashboard deployment; the metrics API remains available via CLI regardless
- `nucleus.enabled` — Deploy Nucleus server for USD asset storage and collaboration (default: false)
- `nucleus.metricsEnabled` — Deploy Nucleus monitoring (API latency, CPU, memory) to dashboard
- `nucleus.instanceType` — EC2 instance type for Nucleus (default: c5.2xlarge)

Review and modify as needed before deployment.
