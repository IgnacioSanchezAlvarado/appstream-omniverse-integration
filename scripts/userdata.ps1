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

# Kit App Template — clone to shared location (NOT PhotonUser home to avoid profile conflicts)
L "Checking for Kit App Template..."
$kitPath = "C:\Omniverse\kit-app-template"
if (Test-Path "$kitPath\.git") {
    L "Kit App Template already cloned, skipping."
} else {
    L "Cloning Kit App Template..."
    New-Item -Path "C:\Omniverse" -ItemType Directory -Force | Out-Null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine")
    & "C:\Program Files\Git\bin\git.exe" clone https://github.com/NVIDIA-Omniverse/kit-app-template $kitPath 2>&1 | Out-File $log -Append
    if (Test-Path "$kitPath\.git") {
        L "Kit App Template cloned successfully."
        # Grant Everyone full control so PhotonUser can build/modify at session time
        icacls $kitPath /grant "Everyone:(OI)(CI)F" /T /Q 2>&1 | Out-File $log -Append
    } else {
        L "WARNING: Kit App Template clone may have failed, check log."
    }
}

# Packman cache directory — repo.bat uses \packman-repo at drive root by default
# PhotonUser can't create root-level dirs, so pre-create and set PM_PACKAGES_ROOT
# to always point here regardless of current drive
L "Creating packman cache directory and setting PM_PACKAGES_ROOT..."
New-Item -Path "C:\packman-repo" -ItemType Directory -Force | Out-Null
icacls "C:\packman-repo" /grant "Everyone:(OI)(CI)F" /T /Q 2>&1 | Out-File $log -Append
[System.Environment]::SetEnvironmentVariable("PM_PACKAGES_ROOT", "C:\packman-repo", "Machine")

# uv (used by packman/repoman) defaults cache to %LOCALAPPDATA%\uv\cache which lands on D: (S3-backed, no space)
L "Setting UV_CACHE_DIR to C:\packman-repo\uv-cache..."
New-Item -Path "C:\packman-repo\uv-cache" -ItemType Directory -Force | Out-Null
icacls "C:\packman-repo\uv-cache" /grant "Everyone:(OI)(CI)F" /T /Q 2>&1 | Out-File $log -Append
[System.Environment]::SetEnvironmentVariable("UV_CACHE_DIR", "C:\packman-repo\uv-cache", "Machine")

# Omniverse Kit extension cache defaults to %LOCALAPPDATA%\ov\data which lands on D: (S3-backed, no space)
# OMNI_DATA_PATH redirects all Kit data (extensions cache, logs, etc.) to C:\
L "Setting OMNI_DATA_PATH to C:\Omniverse\ov-data..."
New-Item -Path "C:\Omniverse\ov-data" -ItemType Directory -Force | Out-Null
icacls "C:\Omniverse\ov-data" /grant "Everyone:(OI)(CI)F" /T /Q 2>&1 | Out-File $log -Append
[System.Environment]::SetEnvironmentVariable("OMNI_DATA_PATH", "C:\Omniverse\ov-data", "Machine")

# Temp directory pre-created for per-user redirect (done at session logon, not machine-level)
# NOTE: Do NOT set machine-level TEMP/TMP — AppStream validation agent uses machine TEMP
L "Pre-creating C:\Temp for per-user redirect at session logon..."
New-Item -Path "C:\Temp" -ItemType Directory -Force | Out-Null
icacls "C:\Temp" /grant "Everyone:(OI)(CI)F" /T /Q 2>&1 | Out-File $log -Append

# Desktop shortcut is created at session logon by nucleus-autoconfig.ps1
# (Not created here to avoid touching C:\Users\PhotonUser which causes profile conflicts)

# Nucleus auto-configuration logon script
L "Creating Nucleus auto-configuration logon script..."
$appStreamDir = "C:\AppStream"
New-Item -Path $appStreamDir -ItemType Directory -Force | Out-Null

$nucleusScriptContent = @'
# Session Auto-Configuration Script
# Runs at each PhotonUser logon to configure persistent storage and Nucleus connection
$logFile = "C:\AppStream\nucleus-autoconfig.log"
function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File $logFile -Append
}

# ── Only run for PhotonUser — exit immediately for system/validation accounts ──
if ($env:USERNAME -ne "PhotonUser") { exit 0 }

# ── Per-user TEMP/TMP redirect (safe here — PhotonUser only, not machine-level) ──
[System.Environment]::SetEnvironmentVariable("TEMP", "C:\Temp", "User")
[System.Environment]::SetEnvironmentVariable("TMP", "C:\Temp", "User")
$env:TEMP = "C:\Temp"
$env:TMP = "C:\Temp"

# ── Per-user PowerShell profile (working directory + PSReadLine history) ──
$psProfileDir = "$env:USERPROFILE\Documents\WindowsPowerShell"
New-Item -Path $psProfileDir -ItemType Directory -Force | Out-Null
$psProfileLines = @(
    'Set-Location C:\Omniverse',
    '$histDir = "C:\AppStream\PSHistory"',
    'if (-not (Test-Path $histDir)) { New-Item -Path $histDir -ItemType Directory -Force | Out-Null }',
    'Set-PSReadLineOption -HistorySavePath "$histDir\ConsoleHost_history.txt" -ErrorAction SilentlyContinue'
)
$psProfileLines | Set-Content "$psProfileDir\profile.ps1" -Encoding UTF8

# ── Check completion marker (prevent re-runs) ──
$completionMarker = "C:\AppStream\nucleus-autoconfig.done"
if (Test-Path $completionMarker) {
    $markerAge = (Get-Date) - (Get-Item $completionMarker).LastWriteTime
    if ($markerAge.TotalMinutes -lt 60) {
        Log "Auto-configuration already completed this session (marker age: $([math]::Round($markerAge.TotalMinutes,1)) minutes), exiting."
        exit 0
    }
}

Log "=== Starting Nucleus Auto-Configuration ==="

# ── Redirect Omniverse Kit data off D: (S3-backed, no space) ──
# Kit stores extension cache in %LOCALAPPDATA%\ov\data\exts which is on D:.
# Create a junction point so D:\...\ov resolves to C:\Omniverse\ov-data (no space limit).
$ovDataC = "C:\Omniverse\ov-data"
$ovLocalPath = "$env:LOCALAPPDATA\ov"
New-Item -Path $ovDataC -ItemType Directory -Force | Out-Null
if (Test-Path $ovLocalPath) {
    $item = Get-Item $ovLocalPath -ErrorAction SilentlyContinue
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Log "Junction already exists: $ovLocalPath -> $ovDataC"
    } else {
        Log "Removing existing ov data dir on D: (will be replaced with junction)..."
        Remove-Item -Path $ovLocalPath -Recurse -Force -ErrorAction SilentlyContinue
        cmd /c "mklink /J `"$ovLocalPath`" `"$ovDataC`"" 2>&1 | ForEach-Object { Log $_ }
        Log "Created junction: $ovLocalPath -> $ovDataC"
    }
} else {
    cmd /c "mklink /J `"$ovLocalPath`" `"$ovDataC`"" 2>&1 | ForEach-Object { Log $_ }
    Log "Created junction: $ovLocalPath -> $ovDataC"
}

try {
    # ── Wait for AppStream Home Folder to mount ──
$homeFolder = "$env:USERPROFILE\My Files\Home Folder"
$maxWaitSeconds = 30
$checkIntervalSeconds = 3
$elapsed = 0

Log "Waiting for Home Folder to mount (max ${maxWaitSeconds}s)..."
while (-not (Test-Path $homeFolder) -and ($elapsed -lt $maxWaitSeconds)) {
    Start-Sleep -Seconds $checkIntervalSeconds
    $elapsed += $checkIntervalSeconds
    Log "Waiting for Home Folder... (${elapsed}s elapsed)"
}

if (Test-Path $homeFolder) {
    Log "Home Folder mounted successfully after ${elapsed}s"
} else {
    Log "WARNING: Home Folder did not mount after ${maxWaitSeconds}s, proceeding with local paths"
}

# ── Omniverse Source Sync ──
# Only sync user-created source files (apps/extensions), NOT the full kit-app-template.
# D: is S3-backed and can't handle build tools, packman, symlinks, etc.
# Folder named "omniverse-projects" to avoid confusion with kit-app-template on C:.
$sourceLocal = "C:\Omniverse\kit-app-template\source"
$sourceHome = "$homeFolder\omniverse-projects"

if (Test-Path $homeFolder) {
    Log "Home Folder found at: $homeFolder"
    if (Test-Path "$sourceHome\apps") {
        # Returning user: restore source files from Home Folder
        Log "Restoring Omniverse source files from Home Folder..."
        $robocopyResult = robocopy $sourceHome $sourceLocal /E /R:3 /W:5 2>&1
        Log "Restore robocopy exit code: $LASTEXITCODE"
        if ($LASTEXITCODE -ge 8) { Log "Robocopy output: $($robocopyResult | Out-String)" }
        if ($LASTEXITCODE -lt 8) {
            Log "Omniverse source files restored from Home Folder successfully."
        } else {
            Log "WARNING: Restore from Home Folder failed (exit=$LASTEXITCODE), using AMI defaults."
        }
    } elseif (Test-Path $sourceLocal) {
        Log "First session: using AMI-baked source. Background sync will handle backup."
    } else {
        Log "WARNING: source directory not found locally or in Home Folder."
    }

    # Start background sync: source/ → Home Folder every 60 seconds
    $syncScript = @"
while (`$true) {
    Start-Sleep -Seconds 60
    if ((Test-Path '$sourceLocal') -and (Test-Path '$homeFolder')) {
        robocopy '$sourceLocal' '$sourceHome' /E /R:1 /W:2 /NP /NFL /NDL /NJH /NJS /XO 2>&1 | Out-Null
        "`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Background sync completed (exit=`$LASTEXITCODE)" | Out-File 'C:\AppStream\kit-sync.log' -Append
    }
}
"@
    Start-Job -ScriptBlock ([scriptblock]::Create($syncScript)) | Out-Null
    Log "Started background sync job (source -> Home Folder every 60s)"
} else {
    Log "Home Folder not available, using local source only (no persistence)."
}
$kitPath = "C:\Omniverse\kit-app-template"
Log "Kit App Template path: $kitPath"

# Get instance region using IMDSv2
    Log "Fetching instance region from EC2 metadata (IMDSv2)..."
    $tokenUrl = "http://169.254.169.254/latest/api/token"
    $metadataUrl = "http://169.254.169.254/latest/meta-data/placement/region"

    $token = Invoke-RestMethod -Uri $tokenUrl -Method PUT -Headers @{"X-aws-ec2-metadata-token-ttl-seconds" = "21600"} -ErrorAction Stop
    $region = Invoke-RestMethod -Uri $metadataUrl -Headers @{"X-aws-ec2-metadata-token" = $token} -ErrorAction Stop
    Log "Instance region: $region"

    # Check if AWS CLI is available
    $awsCli = Get-Command aws -ErrorAction SilentlyContinue
    if (-not $awsCli) {
        $awsCli = Test-Path "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
        if ($awsCli) {
            $awsExe = "C:\Program Files\Amazon\AWSCLIV2\aws.exe"
        } else {
            Log "AWS CLI not found, exiting."
            exit 0
        }
    } else {
        $awsExe = "aws"
    }
    Log "Using AWS CLI: $awsExe"

    # Query SSM for Nucleus endpoint
    $ssmParam = "/appstream-omniverse/nucleus/endpoint"
    Log "Querying SSM parameter: $ssmParam"

    $output = & $awsExe ssm get-parameter --name $ssmParam --region $region --profile appstream_machine_role 2>&1
    if ($LASTEXITCODE -ne 0) {
        Log "SSM parameter not found or not accessible. Nucleus may not be deployed. Exiting silently."
        exit 0
    }

    # Parse JSON output
    $paramData = $output | ConvertFrom-Json -ErrorAction Stop
    $nucleusIp = $paramData.Parameter.Value
    Log "Nucleus IP retrieved: $nucleusIp"

    if (-not $nucleusIp) {
        Log "Nucleus IP is empty, exiting."
        exit 0
    }

    # Write omni.client bookmark config
    # This is the standard platform config read by ALL Kit apps for saved Nucleus servers
    # Path: ~/.nvidia-omniverse/config/omniverse.toml, format: [bookmarks] "ip" = "omniverse://ip"
    $nvOvConfigDir = "$env:USERPROFILE\.nvidia-omniverse\config"
    New-Item -Path $nvOvConfigDir -ItemType Directory -Force | Out-Null
    $nvOvTomlPath = "$nvOvConfigDir\omniverse.toml"
    $bookmarkLines = @()
    $bookmarkLines += "[bookmarks]"
    $bookmarkLines += "`"$nucleusIp`" = `"omniverse://$nucleusIp`""
    $utf8NoBOM = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllLines($nvOvTomlPath, $bookmarkLines, $utf8NoBOM)
    Log "Created omni.client bookmark at $nvOvTomlPath"

    # Create desktop shortcut to Nucleus
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    if (-not $desktopPath) { $desktopPath = "$env:USERPROFILE\Desktop" }
    New-Item -Path $desktopPath -ItemType Directory -Force | Out-Null

    $shell = New-Object -ComObject WScript.Shell
    $navShortcut = $shell.CreateShortcut("$desktopPath\Nucleus Navigator.lnk")
    $navShortcut.TargetPath = "explorer.exe"
    $navShortcut.Arguments = "http://${nucleusIp}:8080"
    $navShortcut.IconLocation = "shell32.dll,13"
    $navShortcut.Description = "Open Nucleus Navigator web UI"
    $navShortcut.Save()
    Log "Created desktop shortcut: Nucleus Navigator.lnk"

    # Create nucleus-info.txt on desktop
    $infoFile = "$desktopPath\nucleus-info.txt"
    $infoContent = @"
Nucleus Server Connection
=========================
Server IP: $nucleusIp
Connection: omniverse://$nucleusIp
Web UI: http://${nucleusIp}:8080

To connect in Omniverse:
1. Open any Omniverse app (e.g. USD Composer)
2. Go to File > Open > Nucleus tab
3. The server should appear in saved servers
4. Or enter: omniverse://$nucleusIp
5. Login with your Nucleus username and password

Nucleus Credentials
===================
The admin username is: omniverse
The admin password is stored in AWS Secrets Manager.

Retrieve it with the AWS CLI:
  aws secretsmanager get-secret-value \
    --secret-id appstream-omniverse/nucleus/admin \
    --region eu-central-1 \
    --query SecretString --output text

Or in the AWS Console:
  Secrets Manager > appstream-omniverse/nucleus/admin > Retrieve secret value

Permanent File Storage
======================
Files on C:\ are LOCAL only and will be LOST when your session ends.
To keep files across sessions, save them to your Home Folder:
  D:\PhotonUser\My Files\Home Folder

Note: The Home Folder is backed by S3 and does not support
NTFS symlinks or junctions. Use C:\ for build tools and
development work — a background sync copies your Omniverse
project files to the Home Folder every 60 seconds automatically.
"@
    $infoContent | Out-File $infoFile -Encoding UTF8 -Force
    Log "Created nucleus-info.txt on desktop"

    # Create Kit App Template desktop shortcut (uses $kitPath set earlier)
    if (Test-Path $kitPath) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut("$desktopPath\Kit App Template.lnk")
        $shortcut.TargetPath = $kitPath
        $shortcut.IconLocation = "shell32.dll,3"
        $shortcut.Description = "NVIDIA Omniverse Kit App Template"
        $shortcut.Save()
        Log "Created Kit App Template desktop shortcut"
    }

    # Auto-arrange desktop icons so shortcuts stack below existing icons
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DesktopHelper {
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string win);
    [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string win);
    [DllImport("user32.dll")] public static extern int SendMessage(IntPtr hwnd, int msg, int wp, int lp);
    public static void AutoArrange() {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr defview = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defview == IntPtr.Zero) {
            // Try WorkerW (Windows 10/Server alternative)
            IntPtr workerW = IntPtr.Zero;
            do {
                workerW = FindWindowEx(IntPtr.Zero, workerW, "WorkerW", null);
                defview = FindWindowEx(workerW, IntPtr.Zero, "SHELLDLL_DefView", null);
            } while (defview == IntPtr.Zero && workerW != IntPtr.Zero);
        }
        if (defview != IntPtr.Zero) {
            IntPtr listview = FindWindowEx(defview, IntPtr.Zero, "SysListView32", null);
            if (listview != IntPtr.Zero) {
                SendMessage(listview, 0x1016, 0, 0); // LVM_ARRANGE, LVA_DEFAULT
            }
        }
    }
}
"@ -ErrorAction SilentlyContinue
        [DesktopHelper]::AutoArrange()
        Log "Desktop icons auto-arranged"
    } catch {
        Log "Desktop auto-arrange skipped: $($_.Exception.Message)"
    }

    # Write completion marker
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File $completionMarker -Force
    Log "Completion marker written to $completionMarker"

    Log "=== Nucleus auto-configuration complete ==="

} catch {
    Log "ERROR: $($_.Exception.Message)"
    Log "Stack trace: $($_.ScriptStackTrace)"
}
'@

# Write the script file
$nucleusScriptPath = "$appStreamDir\nucleus-autoconfig.ps1"
$nucleusScriptContent | Set-Content $nucleusScriptPath -Encoding UTF8 -Force
L "Nucleus logon script created at: $nucleusScriptPath"

# Register machine-level logon script via HKLM Run registry key
# This survives AppStream's PhotonUser profile reset (unlike per-user scheduled tasks)
L "Registering Nucleus auto-config via HKLM Run registry..."
$runKeyPath = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run"
Set-ItemProperty -Path $runKeyPath -Name "NucleusAutoConfig" -Value "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File $nucleusScriptPath"
L "HKLM Run registry key 'NucleusAutoConfig' set successfully."

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
