# =====================================================================
# VPS Agent Deployment Script for Windows Server 2022 (Tokyo Node)
# =====================================================================
# Run this script in an Administrator PowerShell prompt on the Windows VPS

param (
    [string]$VpsId = "vps1",
    [string]$VpsName = "VPS 1 (Tokyo Win 2022)",
    [string]$HubUrl = "https://app.hoangngocbach.id.vn/api/telemetry",
    [string]$Secret = "secret-token-change-me",
    [string]$InstallDir = "C:\vps-agent"
)

Write-Host "=== Setting up VPS Agent on Windows Server ===" -ForegroundColor Cyan

# 1. Create installation directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Write-Host "Created directory: $InstallDir" -ForegroundColor Green
}

# 2. Create Startup / Execution Script
$RunnerPath = "$InstallDir\run-agent.bat"
$RunnerContent = @"
@echo off
cd /d "$InstallDir"
vps-agent-windows.exe -port 8085 -vps-id "$VpsId" -vps-name "$VpsName" -hub-url "$HubUrl" -secret "$Secret" -interval 30s -data-dir "$InstallDir\data" >> "$InstallDir\agent.log" 2>&1
"@
Set-Content -Path $RunnerPath -Value $RunnerContent
Write-Host "Created runner script: $RunnerPath" -ForegroundColor Green

# 3. Create Task Scheduler Task for Auto-Start on System Boot
$TaskName = "VPSHub-Agent"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction -Execute $RunnerPath
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null

Write-Host "Registered Scheduled Task: $TaskName (runs at startup with SYSTEM privileges)" -ForegroundColor Green

# 4. Open Inbound Port 8085 in Windows Defender Firewall for local tunnel
New-NetFirewallRule -DisplayName "VPS Hub Agent (8085)" -Direction Inbound -LocalPort 8085 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
Write-Host "Allowed TCP Port 8085 in Windows Firewall" -ForegroundColor Green

Write-Host "=== Deployment Completed! ===" -ForegroundColor Cyan
Write-Host "Place 'vps-agent-windows.exe' into $InstallDir and start the task:"
Write-Host "Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Yellow
