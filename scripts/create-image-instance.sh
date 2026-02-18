#!/bin/bash
set -euo pipefail

# Configuration
REGION="eu-central-1"
AMI_ID="ami-08f7638d7dc2a351c"
INSTANCE_TYPE="g6e.xlarge"
PROJECT="appstream-omniverse"
VOLUME_SIZE=100

# Check for required argument
if [ $# -lt 1 ]; then
  echo "Usage: $0 <KEY_PAIR_NAME>"
  echo "Example: $0 my-ec2-keypair"
  exit 1
fi

KEY_PAIR_NAME="$1"

echo "===> Looking up VPC from CloudFormation stack..."
VPC_ID=$(aws cloudformation describe-stacks \
  --stack-name AppStreamOmniverseStack \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' \
  --output text)

if [ -z "$VPC_ID" ]; then
  echo "ERROR: Could not find VpcId output in AppStreamOmniverseStack"
  exit 1
fi
echo "Found VPC: $VPC_ID"

echo "===> Finding public subnet in VPC..."
SUBNET_ID=$(aws ec2 describe-subnets \
  --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=map-public-ip-on-launch,Values=true" \
  --query 'Subnets[0].SubnetId' \
  --output text)

if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" == "None" ]; then
  echo "ERROR: Could not find public subnet in VPC $VPC_ID"
  exit 1
fi
echo "Found subnet: $SUBNET_ID"

echo "===> Creating security group..."
SG_NAME="$PROJECT-image-builder-sg"
SG_ID=$(aws ec2 create-security-group \
  --region "$REGION" \
  --group-name "$SG_NAME" \
  --description "Allow RDP for AppStream image builder (POC only)" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' \
  --output text 2>/dev/null || \
  aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' \
    --output text)

echo "Security group: $SG_ID"

aws ec2 authorize-security-group-ingress \
  --region "$REGION" \
  --group-id "$SG_ID" \
  --protocol tcp \
  --port 3389 \
  --cidr 0.0.0.0/0 2>/dev/null || echo "RDP rule already exists"

aws ec2 create-tags \
  --region "$REGION" \
  --resources "$SG_ID" \
  --tags "Key=Name,Value=$SG_NAME" "Key=Project,Value=$PROJECT"

echo "===> Preparing UserData script..."
USER_DATA=$(cat <<'EOF'
<powershell>
# ========================================
# Omniverse Image Builder Auto Setup
# ========================================

# 1. Setup logging
$logFile = "C:\OmniverseSetup\setup-log.txt"
New-Item -ItemType Directory -Path "C:\OmniverseSetup" -Force | Out-Null
Start-Transcript -Path $logFile -Append

Write-Host "===> Starting Omniverse auto-setup..."

# 2. Install Chocolatey
Write-Host "===> Installing Chocolatey..."
try {
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    Write-Host "Chocolatey installed successfully."
} catch {
    Write-Host "ERROR installing Chocolatey: $_"
    exit 1
}

# 3. Install Git + Git LFS + Chrome via Chocolatey
Write-Host "===> Installing Git, Git LFS, and Chrome..."
try {
    choco install -y git git-lfs googlechrome --no-progress
    Write-Host "Git, Git LFS, and Chrome installed successfully."
} catch {
    Write-Host "ERROR installing packages: $_"
}

# Refresh PATH after git install
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# 4. Install Visual Studio 2022 Build Tools with C++ workload
Write-Host "===> Installing Visual Studio 2022 Build Tools (this takes 10-15 minutes)..."
try {
    choco install -y visualstudio2022buildtools --package-parameters "--add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended --passive --norestart" --no-progress
    Write-Host "Visual Studio 2022 Build Tools installed successfully."
} catch {
    Write-Host "ERROR installing Visual Studio Build Tools: $_"
}

# 5. Download and install NVIDIA Data Center drivers for L40S
Write-Host "===> Downloading NVIDIA Data Center driver..."
$nvDriverDir = "C:\OmniverseSetup\nvidia-driver"
New-Item -ItemType Directory -Path $nvDriverDir -Force | Out-Null

# Use known working driver URL with fallback logic
try {
    $lookupUrl = "https://www.nvidia.com/Download/processFind.aspx?psid=955&pfid=1010&osid=119&lid=1&whql=1&lang=en-us&ctk=0&qnfslb=00&dtcid=0"
    $downloadUrl = $null

    try {
        $response = Invoke-WebRequest -Uri $lookupUrl -UseBasicParsing -TimeoutSec 30
        if ($response.Content -match '(/Windows/Quadro_Certified/[\d.]+/[\d.]+-.*\.exe)') {
            $driverPath = $Matches[1]
            $downloadUrl = "https://us.download.nvidia.com$driverPath"
        } elseif ($response.Content -match '(/Windows/[\d.]+/[\d.]+-.*\.exe)') {
            $driverPath = $Matches[1]
            $downloadUrl = "https://us.download.nvidia.com$driverPath"
        }
    } catch {
        Write-Host "Could not fetch latest driver info, using known working version."
    }

    # Fallback to known working driver if lookup failed
    if (-not $downloadUrl) {
        $downloadUrl = "https://us.download.nvidia.com/tesla/572.83/572.83-data-center-tesla-desktop-winserver-2022-dch-international.exe"
    }

    Write-Host "Downloading NVIDIA driver from: $downloadUrl"
    $driverInstaller = "$nvDriverDir\nvidia-driver.exe"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $driverInstaller -UseBasicParsing

    # Silent install
    Write-Host "Installing NVIDIA driver (this takes 5-10 minutes)..."
    Start-Process -FilePath $driverInstaller -ArgumentList "-s -noreboot" -Wait -NoNewWindow
    Write-Host "NVIDIA driver installed successfully."
} catch {
    Write-Host "ERROR downloading/installing NVIDIA driver: $_"
    Write-Host "You may need to install drivers manually after reboot."
}

# 6. Clone Kit App Template
Write-Host "===> Cloning Kit App Template..."
try {
    $kitDir = "C:\OmniverseSetup\kit-app-template"
    $gitExe = "C:\Program Files\Git\bin\git.exe"

    if (Test-Path $gitExe) {
        & $gitExe clone https://github.com/NVIDIA-Omniverse/kit-app-template.git $kitDir
        Set-Location $kitDir
        & $gitExe lfs install
        & $gitExe lfs pull
        Write-Host "Kit App Template cloned successfully."
    } else {
        Write-Host "ERROR: Git executable not found at $gitExe"
    }
} catch {
    Write-Host "ERROR cloning Kit App Template: $_"
}

# 7. Create desktop README and shortcuts
Write-Host "===> Creating desktop README..."
try {
    $setupDir = "C:\Users\Public\Desktop\OmniverseSetup"
    New-Item -ItemType Directory -Path $setupDir -Force | Out-Null

    $readme = @"
Omniverse Image Builder - Auto Setup Complete
==============================================

Installed automatically:
- NVIDIA Data Center drivers (L40S)
- Visual Studio 2022 Build Tools (C++ workload)
- Git + Git LFS
- Google Chrome
- Kit App Template (C:\OmniverseSetup\kit-app-template)

Post-reboot steps:
1. Verify GPU: Open PowerShell, run nvidia-smi
2. Build Kit App:
   cd C:\OmniverseSetup\kit-app-template
   .\repo.bat build
3. Launch Kit App:
   .\repo.bat launch
   (First launch takes 5-8 min for shader compilation)
4. When satisfied, create AMI for AppStream import

Setup log: C:\OmniverseSetup\setup-log.txt
"@

    $readme | Out-File -FilePath "$setupDir\README.txt" -Encoding UTF8
    Write-Host "Desktop README created."
} catch {
    Write-Host "ERROR creating README: $_"
}

# 8. Schedule reboot (needed after NVIDIA driver install)
Write-Host "===> Auto-setup complete! Rebooting in 60 seconds..."
Stop-Transcript
shutdown /r /t 60 /c "Rebooting to complete NVIDIA driver installation"
</powershell>
EOF
)

echo "===> Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_PAIR_NAME" \
  --subnet-id "$SUBNET_ID" \
  --security-group-ids "$SG_ID" \
  --associate-public-ip-address \
  --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOLUME_SIZE,VolumeType=gp3,Encrypted=false,DeleteOnTermination=true}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$PROJECT-image-builder},{Key=Project,Value=$PROJECT}]" \
  --user-data "$USER_DATA" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "Instance launched: $INSTANCE_ID"
echo "===> Waiting for instance to get public IP..."

PUBLIC_IP=""
for i in {1..30}; do
  PUBLIC_IP=$(aws ec2 describe-instances \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text 2>/dev/null || echo "")

  if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" != "None" ]; then
    break
  fi
  sleep 2
done

if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" == "None" ]; then
  echo "WARNING: Could not retrieve public IP yet. Check console."
  PUBLIC_IP="<pending>"
fi

echo ""
echo "======================================================"
echo "Instance created successfully!"
echo "======================================================"
echo "Instance ID: $INSTANCE_ID"
echo "Public IP:   $PUBLIC_IP"
echo ""
echo "To get the Windows Administrator password:"
echo "  aws ec2 get-password-data --instance-id $INSTANCE_ID --priv-launch-key /path/to/$KEY_PAIR_NAME.pem --region $REGION"
echo ""
echo "To connect via RDP:"
echo "  1. Wait 5-10 minutes for instance to boot"
echo "  2. Get password using command above"
echo "  3. RDP to $PUBLIC_IP with username 'Administrator'"
echo "  4. Check Desktop\\OmniverseSetup\\README.txt for setup steps"
echo "======================================================"
