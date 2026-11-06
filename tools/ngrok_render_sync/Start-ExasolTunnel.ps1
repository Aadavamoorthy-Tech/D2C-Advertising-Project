# Keeps Render's EXASOL_DSN in sync with the current ngrok TCP address.
# Usage (from the repository root):
#   .\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -DryRun
#   .\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -Wait -VerifyUrl https://<your-backend>.onrender.com/api/datasets/status
#   .\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -Watch
#   .\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -Stop
#   .\tools\ngrok_render_sync\Start-ExasolTunnel.ps1 -InstallTask
param(
    [switch]$DryRun,
    [switch]$Wait,
    [string]$VerifyUrl,
    [switch]$Watch,
    [switch]$ForceDeploy,
    [switch]$AllowCreate,
    [switch]$Stop,
    [switch]$StopOnExit,
    [switch]$InstallTask,
    [switch]$UninstallTask,
    [switch]$InstallHelperTask,
    [switch]$UninstallHelperTask,
    [switch]$EnsureExasolOnly,
    [switch]$TaskLog
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')
$stateDir = Join-Path $here '.state'
$taskName = 'D2C Exasol ngrok Render sync'
$helperTaskName = 'D2C Exasol helper'

function Get-LocalSetting([string]$Name) {
    $file = Join-Path $here 'local.env'
    if (Test-Path $file) {
        foreach ($line in Get-Content $file) {
            if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*?)\s*$')) {
                return $Matches[1].Trim('"').Trim("'")
            }
        }
    }
    return $null
}

function Get-Setting([string]$Name, [string]$Default) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not $value) { $value = Get-LocalSetting $Name }
    if (-not $value) { return $Default }
    return $value
}

function Test-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMilliseconds = 1500) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $result.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) { return $false }
        $client.EndConnect($result)
        return $true
    }
    catch { return $false }
    finally { $client.Close() }
}

function Get-ExakitStatus($Exakit) {
    $output = (& $Exakit status --json 2>&1 | Out-String).Trim()
    $code = $LASTEXITCODE
    try {
        $status = $output | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "Could not read exakit status --json (exit $code). Check Exakit installation and run 'exakit status --json' manually."
    }
    return @{ Code = $code; Data = $status }
}

function Ensure-ExasolRuntime([string]$HostName, [int]$Port) {
    $exakitCommand = Get-Command exakit -ErrorAction SilentlyContinue
    if (-not $exakitCommand) {
        throw "Exakit was not found. Install/configure the Exasol Personal Starter Kit, then run 'exakit status'. This launcher will not install Exasol."
    }

    $exakit = $exakitCommand.Source
    $result = Get-ExakitStatus $exakit
    if ($result.Data.running -eq $true -or $result.Data.status -eq 'running') {
        Write-Host 'Exasol runtime is already running.'
    }
    elseif ($result.Data.status -eq 'interrupted' -or $result.Data.runtime.status -eq 'interrupted') {
        throw "Exakit reports an interrupted runtime that needs manual attention. No repair was attempted. 'exakit repair-runtime' rebuilds the deployment and destroys its data; inspect 'exakit status --json' and logs before deciding."
    }
    elseif (-not $result.Data.installed -or $result.Code -eq 4) {
        throw "Exakit reports that Exasol is not installed. Install it deliberately, then rerun this launcher."
    }
    elseif ($result.Data.status -eq 'stopped' -or $result.Data.runtime.status -eq 'stopped') {
        Write-Host 'Exasol is installed but stopped; starting it with exakit ...'
        & $exakit start
        $startCode = $LASTEXITCODE
        if ($startCode -ne 0) {
            $after = Get-ExakitStatus $exakit
            if ($after.Data.status -eq 'interrupted' -or $after.Data.runtime.status -eq 'interrupted') {
                throw "Exakit start reported an interrupted runtime. No repair was attempted. 'exakit repair-runtime' is destructive; inspect status and logs first."
            }
            throw "exakit start failed (exit $startCode). Check 'exakit status' and 'exakit logs'; no installation or repair was attempted."
        }
    }
    else {
        throw "Exakit did not report a known running or stopped state (status '$($result.Data.status)', exit $($result.Code)). Run 'exakit status --json' and resolve it before continuing."
    }

    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpPort $HostName $Port) {
            Write-Host "Exasol is accepting connections on ${HostName}:$Port."
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "Exasol did not accept TCP connections on ${HostName}:$Port within 3 minutes. Check 'exakit status' and 'exakit logs'."
}

function Assert-TaskConfiguration {
    foreach ($name in @('RENDER_API_KEY', 'RENDER_SERVICE_ID')) {
        $value = Get-Setting $name ''
        if (-not $value -or $value -match '^REPLACE_WITH_') {
            throw "Set $name in tools\ngrok_render_sync\local.env (or as a Windows user environment variable) before installing the Scheduled Task. Do not put secrets in chat."
        }
    }
}

function Install-WatchTask {
    Assert-TaskConfiguration
    $powerShell = Join-Path $PSHOME 'powershell.exe'
    $script = Join-Path $here 'Start-ExasolTunnel.ps1'
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" -Watch -TaskLog'
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $repo.Path
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts an installed Exasol runtime if stopped, then monitors its ngrok tunnel and Render EXASOL_DSN.' -Force | Out-Null
    Write-Host "Scheduled Task '$taskName' registered for the current user at logon."
    Write-Host 'It requires tools\ngrok_render_sync\local.env or user environment variables to contain Render credentials.'
    Write-Host "Task log: $stateDir\automation-*.log"
}

function Uninstall-WatchTask {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $taskName
        }
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Stopped and removed Scheduled Task '$taskName'. Exasol and any ngrok process are not stopped."
    }
    else {
        Write-Host "Scheduled Task '$taskName' is not registered."
    }
}

function Assert-HelperTaskConfiguration {
    foreach ($name in @('RENDER_API_KEY', 'RENDER_SERVICE_ID', 'HELPER_TOKEN', 'BACKEND_URL')) {
        $value = Get-Setting $name ''
        if (-not $value -or $value -match '^REPLACE_WITH_') {
            throw "Set $name in tools\ngrok_render_sync\local.env (or as a Windows user environment variable) before installing the helper task."
        }
    }
}

function Install-HelperTask {
    Assert-HelperTaskConfiguration
    $python = Join-Path $repo '.venv\Scripts\python.exe'
    if (-not (Test-Path $python)) { $python = (Get-Command python -ErrorAction Stop).Source }
    $helper = Join-Path $repo 'tools\db_helper\helper.py'
    $arguments = '"' + $helper + '"'
    $action = New-ScheduledTaskAction -Execute $python -Argument $arguments -WorkingDirectory $repo.Path
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $helperTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Polls the hosted AdPilot backend for authenticated database-start requests.' -Force | Out-Null
    Write-Host "Scheduled Task '$helperTaskName' registered for the current user at logon."
    Write-Host "Helper log: $here\.state\helper-*.log"
}

function Uninstall-HelperTask {
    $task = Get-ScheduledTask -TaskName $helperTaskName -ErrorAction SilentlyContinue
    if ($task) {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $helperTaskName
        }
        Unregister-ScheduledTask -TaskName $helperTaskName -Confirm:$false
        Write-Host "Stopped and removed Scheduled Task '$helperTaskName'. Exasol and any ngrok process are not stopped."
    }
    else {
        Write-Host "Scheduled Task '$helperTaskName' is not registered."
    }
}

if ($TaskLog) {
    New-Item -ItemType Directory -Force $stateDir | Out-Null
    $logPath = Join-Path $stateDir ("automation-{0}.log" -f (Get-Date -Format 'yyyyMM'))
    Start-Transcript -Path $logPath -Append | Out-Null
}

if (($InstallTask -and $UninstallTask) -or ($InstallHelperTask -and $UninstallHelperTask)) {
    if ($TaskLog) { Stop-Transcript | Out-Null }
    throw 'Choose only one install or uninstall task switch.'
}
if ($InstallTask) {
    try { Install-WatchTask }
    finally { if ($TaskLog) { Stop-Transcript | Out-Null } }
    exit 0
}
if ($UninstallTask) {
    try { Uninstall-WatchTask }
    finally { if ($TaskLog) { Stop-Transcript | Out-Null } }
    exit 0
}
if ($InstallHelperTask) {
    try { Install-HelperTask }
    finally { if ($TaskLog) { Stop-Transcript | Out-Null } }
    exit 0
}
if ($UninstallHelperTask) {
    try { Uninstall-HelperTask }
    finally { if ($TaskLog) { Stop-Transcript | Out-Null } }
    exit 0
}

if ($EnsureExasolOnly) {
    if ($DryRun -or $Wait -or $VerifyUrl -or $Watch -or $ForceDeploy -or $AllowCreate -or $Stop -or $StopOnExit) {
        throw '-EnsureExasolOnly cannot be combined with sync or stop options.'
    }
    $dbHost = Get-Setting 'EXASOL_LOCAL_HOST' '127.0.0.1'
    $dbPort = 8563
    if (-not [int]::TryParse((Get-Setting 'EXASOL_LOCAL_PORT' '8563'), [ref]$dbPort) -or $dbPort -lt 1 -or $dbPort -gt 65535) {
        throw 'EXASOL_LOCAL_PORT must be an integer between 1 and 65535.'
    }
    Ensure-ExasolRuntime $dbHost $dbPort
    exit 0
}

$python = Join-Path $repo '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { $python = 'python' }

$arguments = @()
if ($DryRun) { $arguments += '--dry-run' }
if ($Wait) { $arguments += '--wait' }
if ($VerifyUrl) { $arguments += @('--verify-url', $VerifyUrl) }
if ($Watch) { $arguments += '--watch' }
if ($ForceDeploy) { $arguments += '--force-deploy' }
if ($AllowCreate) { $arguments += '--allow-create' }
if ($Stop) { $arguments += '--stop' }
if ($StopOnExit) { $arguments += '--stop-on-exit' }

try {
    if (-not $Stop) {
        $dbHost = Get-Setting 'EXASOL_LOCAL_HOST' '127.0.0.1'
        $dbPort = 8563
        if (-not [int]::TryParse((Get-Setting 'EXASOL_LOCAL_PORT' '8563'), [ref]$dbPort) -or $dbPort -lt 1 -or $dbPort -gt 65535) {
            throw 'EXASOL_LOCAL_PORT must be an integer between 1 and 65535.'
        }
        Ensure-ExasolRuntime $dbHost $dbPort
    }

    & $python (Join-Path $here 'ngrok_render_sync.py') @arguments
    $exitCode = $LASTEXITCODE
}
finally {
    if ($TaskLog) { Stop-Transcript | Out-Null }
}
exit $exitCode
