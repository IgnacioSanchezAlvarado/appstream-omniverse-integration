#!/bin/bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: $0 INSTANCE_ID"
  echo "Example: $0 i-1234567890abcdef0"
  exit 1
fi

INSTANCE_ID=$1
REGION=eu-central-1
AMI_NAME="omniverse-kit-appstream-$(date +%Y%m%d-%H%M%S)"

echo "Creating AMI from instance $INSTANCE_ID in $REGION..."
echo "AMI name: $AMI_NAME"
echo ""

echo "Step 1: Stopping instance..."
aws ec2 stop-instances --instance-ids "$INSTANCE_ID" --region "$REGION" > /dev/null
echo "Waiting for instance to stop..."
aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID" --region "$REGION"
echo "Instance stopped."
echo ""

echo "Step 2: Creating AMI..."
AMI_ID=$(aws ec2 create-image \
  --instance-id "$INSTANCE_ID" \
  --name "$AMI_NAME" \
  --description "Omniverse Kit AppStream image created from $INSTANCE_ID" \
  --no-reboot \
  --region "$REGION" \
  --output text)

echo "AMI created: $AMI_ID"
echo ""

echo "Step 3: Tagging AMI..."
aws ec2 create-tags \
  --resources "$AMI_ID" \
  --tags Key=Project,Value=appstream-omniverse \
  --region "$REGION"
echo "Tagged successfully."
echo ""

echo "=========================================="
echo "AMI ID: $AMI_ID"
echo "AMI Name: $AMI_NAME"
echo "Region: $REGION"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Wait for AMI to become available (typically 5-10 minutes):"
echo "   aws ec2 describe-images --image-ids $AMI_ID --region $REGION --query 'Images[0].State'"
echo ""
echo "2. Import to AppStream via Console:"
echo "   Navigate to AppStream 2.0 -> Images -> Image Registry -> Import"
echo "   Select $AMI_ID from your AMIs"
echo ""
echo "3. Or use CLI to create image builder:"
echo "   aws appstream create-image-builder \\"
echo "     --name omniverse-builder \\"
echo "     --image-name $AMI_NAME \\"
echo "     --instance-type stream.graphics.g6e.xlarge \\"
echo "     --region $REGION"
