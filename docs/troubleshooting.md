# Troubleshooting

[← Back to README](../README.md)

## Manual Image Build Alternative

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

## Service Role Missing

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

## CLI Metrics Check

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

## Other Common Issues

**`prepare-ami.py` fails with InsufficientInstanceCapacity**
- G6e capacity exhausted in selected AZ. Try different AZ or use manual alternative above.

**Metrics not appearing in dashboard**
- Ensure you've created an active streaming session
- Wait 2-3 minutes for CloudWatch metrics to propagate
- Verify metrics in CLI using the test commands above

**Dashboard shows "Failed to fetch sessions"**
- Check API Gateway logs in CloudWatch (`/aws/lambda/metrics-collector-lambda`)
- Verify fleet is RUNNING and has active or recent sessions
