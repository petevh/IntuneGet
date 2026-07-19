<#
.SYNOPSIS
    Downloads required tools for IntuneGet Packager

.DESCRIPTION
    This script downloads IntuneWinAppUtil.exe and PSAppDeployToolkit
    to the specified tools directory, and ensures the IntuneWin32App
    PowerShell module is installed (used by the IntuneWin32App packaging path).

.PARAMETER ToolsDir
    The directory where tools should be downloaded

.EXAMPLE
    .\download-tools.ps1 -ToolsDir "C:\IntuneGet\tools"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ToolsDir
)

$ErrorActionPreference = "Stop"
# -Force on Install-PackageProvider/Install-Module does NOT suppress the first-run
# "install NuGet provider?" confirmation on a fresh box - only -Confirm:$false does.
# Without this, an unattended run hangs forever waiting for input that never comes.
$ConfirmPreference = "None"

# Create tools directory if it doesn't exist
if (-not (Test-Path $ToolsDir)) {
    New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null
    Write-Host "Created tools directory: $ToolsDir"
}

# Download IntuneWinAppUtil.exe
$intuneWinUtilPath = Join-Path $ToolsDir "IntuneWinAppUtil.exe"
if (-not (Test-Path $intuneWinUtilPath)) {
    Write-Host "Downloading IntuneWinAppUtil.exe..."
    $intuneWinUtilUrl = "https://github.com/microsoft/Microsoft-Win32-Content-Prep-Tool/raw/master/IntuneWinAppUtil.exe"

    try {
        Invoke-WebRequest -Uri $intuneWinUtilUrl -OutFile $intuneWinUtilPath -UseBasicParsing
        Write-Host "Downloaded IntuneWinAppUtil.exe successfully"
    }
    catch {
        Write-Error "Failed to download IntuneWinAppUtil.exe: $_"
        exit 1
    }
}
else {
    Write-Host "IntuneWinAppUtil.exe already exists"
}

# Download PSAppDeployToolkit
$psadtDir = Join-Path $ToolsDir "PSAppDeployToolkit"
if (-not (Test-Path $psadtDir)) {
    Write-Host "Downloading PSAppDeployToolkit..."
    $psadtZipPath = Join-Path $ToolsDir "psadt.zip"
    $psadtUrl = "https://github.com/PSAppDeployToolkit/PSAppDeployToolkit/releases/download/4.1.8/PSAppDeployToolkit_Template_v4.zip"

    try {
        Invoke-WebRequest -Uri $psadtUrl -OutFile $psadtZipPath -UseBasicParsing
        Write-Host "Downloaded PSAppDeployToolkit archive"

        # Extract the archive
        Write-Host "Extracting PSAppDeployToolkit..."
        Expand-Archive -Path $psadtZipPath -DestinationPath $psadtDir -Force
        Write-Host "Extracted PSAppDeployToolkit successfully"

        # Cleanup zip file
        Remove-Item -Path $psadtZipPath -Force
    }
    catch {
        Write-Error "Failed to download/extract PSAppDeployToolkit: $_"
        exit 1
    }
}
else {
    Write-Host "PSAppDeployToolkit already exists"
}

# Ensure the IntuneWin32App module (build tool for the IntuneWin32App packaging path).
# Runs fine on Windows PowerShell 5.1 (module min version is 5.0; v1.5.0 has no external
# deps), so no PowerShell 7 is required on the packager host.
$moduleName = "IntuneWin32App"
if (-not (Get-Module -ListAvailable -Name $moduleName)) {
    Write-Host "Installing $moduleName module..."
    try {
        # PSGallery over TLS 1.2 — Windows PowerShell 5.1 may default to TLS 1.0 and fail.
        [Net.ServicePointManager]::SecurityProtocol = `
            [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

        # First-run bootstrap: the NuGet provider must exist or Install-Module prompts
        # (fatal when unattended).
        if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
            Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Confirm:$false | Out-Null
        }
        # Trust PSGallery so the install doesn't prompt.
        if ((Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue).InstallationPolicy -ne "Trusted") {
            Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
        }

        # AllUsers needs elevation; fall back to CurrentUser if not elevated so a
        # non-admin setup still succeeds (module is then visible only to that account —
        # which must be the one the packager runs as).
        $isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        $scope = if ($isAdmin) { "AllUsers" } else { "CurrentUser" }

        Install-Module -Name $moduleName -Scope $scope -Force -Confirm:$false -AllowClobber
        Write-Host "Installed $moduleName successfully (scope: $scope)"
    }
    catch {
        Write-Error "Failed to install ${moduleName}: $_"
        exit 1
    }
}
else {
    Write-Host "$moduleName module already available"
}

Write-Host ""
Write-Host "All tools downloaded successfully!"
Write-Host "Tools directory: $ToolsDir"
