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

## Runtime Validation Fails During Image Import

AppStream image import with `--runtime-validation-config` can fail with `INTERNAL_ERROR: We encountered an internal error while launching the image builder to qualify the image`. This happens when AppStream cannot launch an Image Builder instance of the specified type due to capacity constraints.

**Symptoms:**
- Image state moves to `FAILED` after 20-40 minutes
- Error message mentions "launching the image builder to qualify the image"
- The image itself is fine — the validation infrastructure can't be provisioned

**Solution:** `prepare-ami.py` automatically handles this by trying multiple validation instance types in order (g6e.xlarge → g6e.2xlarge → g6e.4xlarge → g6e.8xlarge). It pre-checks quotas to skip types with quota=0 and retries with the next size on failure.

If running the import manually, try a larger instance type for validation:
```bash
# If Accelerated.g6e.xlarge fails, try 4xlarge
aws appstream create-imported-image \
  --name omniverse-g6e-retry \
  --source-ami-id <your-ami-id> \
  --iam-role-arn <ImageImportRoleArn> \
  --runtime-validation-config '{"IntendedInstanceType":"Accelerated.g6e.4xlarge"}' \
  --agent-software-version ALWAYS_LATEST \
  --region <your-region>
```

You can check available quotas per instance type:
```bash
aws service-quotas list-service-quotas --service-code appstream2 --region <your-region> \
  | grep -A2 "g6e.*image builders"
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
