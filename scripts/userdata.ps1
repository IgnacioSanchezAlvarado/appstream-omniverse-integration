<powershell>
$log = "C:\PrepAMI.log"
function L($m) { "$(Get-Date -F 'HH:mm:ss') $m" | Out-File $log -Append; Write-Host $m }

L "=== Starting AppStream G6e AMI preparation ==="

# EC2Launch V2
L "Installing EC2Launch V2..."
Invoke-WebRequest -Uri "https://s3.amazonaws.com/amazon-ec2launch-v2/windows/amd64/latest/AmazonEC2Launch.msi" -OutFile C:\Windows\Temp\EC2Launch.msi
Start-Process msiexec.exe -ArgumentList "/i C:\Windows\Temp\EC2Launch.msi /quiet /norestart" -Wait

# SSM Agent
L "Installing SSM Agent..."
Invoke-WebRequest -Uri "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/windows_amd64/AmazonSSMAgentSetup.exe" -OutFile C:\Windows\Temp\SSM.exe
Start-Process C:\Windows\Temp\SSM.exe -ArgumentList "/S" -Wait

# AWS CLI v2
L "Checking for existing AWS CLI..."
$awsCli = Get-Command aws -ErrorAction SilentlyContinue
if (-not $awsCli) {
    $awsCli = Test-Path "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
}
if ($awsCli) {
    L "AWS CLI already installed, skipping install."
} else {
    L "Installing AWS CLI v2..."
    Invoke-WebRequest -Uri "https://awscli.amazonaws.com/AWSCLIV2.msi" -OutFile C:\Windows\Temp\AWSCLIV2.msi
    Start-Process msiexec.exe -ArgumentList "/i C:\Windows\Temp\AWSCLIV2.msi /quiet /norestart" -Wait
}
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")

# NVIDIA driver swap: RTX Enterprise -> GRID
L "Checking NVIDIA driver status..."
$gridKey = Get-ItemProperty -Path "HKLM:\SOFTWARE\NVIDIA Corporation\Global\GridLicensing" -ErrorAction SilentlyContinue
if ($gridKey) {
    L "GRID drivers already installed, skipping driver swap."
} else {
    # Check if any NVIDIA driver is present
    $nvDriver = Get-WmiObject Win32_PnPSignedDriver | Where-Object { $_.DeviceName -like "*NVIDIA*" -and $_.DeviceClass -eq "Display" }
    if ($nvDriver) {
        L "Found non-GRID NVIDIA driver (likely RTX Enterprise), uninstalling..."
        L "Driver details: $($nvDriver.DeviceName) - $($nvDriver.DriverVersion)"

        # Remove NVIDIA driver packages via pnputil
        $infFiles = Get-ChildItem "C:\Windows\INF\oem*.inf" -ErrorAction SilentlyContinue | Where-Object {
            (Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) -match "NVIDIA"
        }
        foreach ($inf in $infFiles) {
            L "Removing driver package: $($inf.Name)"
            pnputil /delete-driver $inf.Name /uninstall /force 2>&1 | Out-File $log -Append
        }
        L "RTX Enterprise drivers removed."
    } else {
        L "No existing NVIDIA drivers found."
    }

    # Install GRID driver from S3
    L "Downloading NVIDIA GRID driver from S3..."
    $dir = "C:\NvidiaGrid"
    New-Item -Path $dir -ItemType Directory -Force | Out-Null
    & "C:\Program Files\Amazon\AWSCLIV2\aws.exe" s3 cp --recursive s3://ec2-windows-nvidia-drivers/latest/ $dir --region us-east-1 2>&1 | Out-File $log -Append

    L "Installing NVIDIA GRID driver..."
    $exe = Get-ChildItem $dir -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 100MB } | Select-Object -First 1
    if ($exe) {
        L "Found installer: $($exe.Name) ($([math]::Round($exe.Length/1MB,2)) MB)"
        Start-Process $exe.FullName -ArgumentList "/s /n" -Wait -NoNewWindow
        L "GRID driver installed successfully."
    } else {
        L "ERROR: No GRID driver installer found in S3 download!"
    }
}

# AppStream firewall ports
L "Opening AppStream ports..."
@(8000,8300,8443) | ForEach-Object {
    New-NetFirewallRule -DisplayName "AppStream $_" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $_ -ErrorAction SilentlyContinue
}

# Git
L "Checking for existing Git..."
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    $git = Test-Path "C:\Program Files\Git\bin\git.exe"
}
if ($git) {
    L "Git already installed, skipping install."
} else {
    L "Installing Git..."
    Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe" -OutFile C:\Windows\Temp\Git.exe
    Start-Process C:\Windows\Temp\Git.exe -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL" -Wait
    L "Git installed."
}

# Kit App Template — clone to PhotonUser home (AppStream session user)
L "Checking for Kit App Template..."
$photonHome = "C:\Users\PhotonUser"
$kitPath = "$photonHome\kit-app-template"
if (Test-Path "$kitPath\.git") {
    L "Kit App Template already cloned, skipping."
} else {
    L "Cloning Kit App Template to PhotonUser home..."
    New-Item -Path $photonHome -ItemType Directory -Force | Out-Null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")
    & "C:\Program Files\Git\bin\git.exe" clone https://github.com/NVIDIA-Omniverse/kit-app-template $kitPath 2>&1 | Out-File $log -Append
    if (Test-Path "$kitPath\.git") {
        L "Kit App Template cloned successfully."
        # Grant PhotonUser full control
        icacls $kitPath /grant "PhotonUser:(OI)(CI)F" /T /Q 2>&1 | Out-File $log -Append
    } else {
        L "WARNING: Kit App Template clone may have failed, check log."
    }
}

# Desktop shortcut to Kit App Template folder
L "Creating desktop shortcut..."
$desktopPath = "$photonHome\Desktop"
New-Item -Path $desktopPath -ItemType Directory -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("$desktopPath\Kit App Template.lnk")
$shortcut.TargetPath = $kitPath
$shortcut.IconLocation = "shell32.dll,3"
$shortcut.Description = "NVIDIA Omniverse Kit App Template"
$shortcut.Save()
L "Desktop shortcut created."

# Disable Windows auto-updates
L "Disabling auto-updates..."
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Name "NoAutoUpdate" -Value 1

# Disable NVIDIA licensing page in control panel
L "Disabling NVIDIA licensing page..."
New-Item -Path "HKLM:\SOFTWARE\NVIDIA Corporation\Global\GridLicensing" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\NVIDIA Corporation\Global\GridLicensing" -Name "NvCplDisableManageLicensePage" -PropertyType "DWord" -Value "1" -Force

# Verify RDS not installed (AppStream requirement)
L "Checking RDS not installed..."
$rl = (Get-WindowsFeature RDS-Licensing).InstallState
$rh = (Get-WindowsFeature RDS-RD-Server).InstallState
L "RDS-Licensing=$rl, RDS-RD-Server=$rh"
if ($rl -eq "Installed" -or $rh -eq "Installed") {
    L "WARNING: RDS components are installed - AppStream requires these to be absent!"
}

# Verify NVIDIA driver is functional
L "Verifying NVIDIA driver..."
$smiPaths = @(
    "C:\Windows\System32\nvidia-smi.exe",
    "C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
)
$smiExe = $smiPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($smiExe) {
    L "Found nvidia-smi at: $smiExe"
    $smi = & $smiExe 2>&1
    L "$smi"
} else {
    # Try from PATH
    try {
        $smi = nvidia-smi 2>&1
        L "$smi"
    } catch {
        L "WARNING: nvidia-smi not found in any standard location or PATH"
    }
}

# Write completion marker
L "=== Preparation complete ==="
"COMPLETE" | Out-File "C:\PrepAMI.complete"
</powershell>
