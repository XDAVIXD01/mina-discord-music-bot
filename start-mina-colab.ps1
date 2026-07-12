param(
    [int]$TimeoutMinutes = 30
)

$ErrorActionPreference = "Stop"

$projectPath = $PSScriptRoot
$envPath = Join-Path $projectPath ".env"
$startScript = Join-Path $projectPath "start-mina.ps1"
$referencePath = Join-Path $projectPath "assets\voice\user_reference.wav"
$colabUrl = "https://colab.research.google.com/github/XDAVIXD01/mina-discord-music-bot/blob/main/colab/mina_voice_colab.ipynb"
$cloudflarePattern = "https://[-a-zA-Z0-9.]+\.trycloudflare\.com"

Add-Type -AssemblyName PresentationFramework

function Show-Info([string]$Message, [string]$Title = "MINA + Colab") {
    [System.Windows.MessageBox]::Show($Message, $Title, "OK", "Information") | Out-Null
}

function Show-Warn([string]$Message, [string]$Title = "MINA + Colab") {
    [System.Windows.MessageBox]::Show($Message, $Title, "OK", "Warning") | Out-Null
}

function Get-EnvValue([string]$Name) {
    if (-not (Test-Path $envPath)) { return "" }
    $line = Select-String -LiteralPath $envPath -Pattern "^$([regex]::Escape($Name))=" | Select-Object -First 1
    if (-not $line) { return "" }
    return $line.Line.Split("=", 2)[1].Trim()
}

function Set-EnvValue([string]$Name, [string]$Value) {
    $lines = @()
    if (Test-Path $envPath) {
        $lines = @(Get-Content -LiteralPath $envPath -Encoding utf8)
    }
    $found = $false
    $updated = foreach ($line in $lines) {
        if ($line -match "^$([regex]::Escape($Name))=") {
            $found = $true
            "$Name=$Value"
        } else {
            $line
        }
    }
    if (-not $found) {
        $updated += "$Name=$Value"
    }
    Set-Content -LiteralPath $envPath -Value $updated -Encoding utf8
}

function Test-RemoteVoice([string]$Url) {
    if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
    try {
        $health = Invoke-RestMethod -Uri ($Url.TrimEnd("/") + "/health") -TimeoutSec 15
        return [bool]($health.ok -and $health.device)
    } catch {
        return $false
    }
}

function Restart-Mina {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript -Mode Restart | Out-Null
    Start-Sleep -Seconds 4
}

function Ensure-StreamTunnel {
    $stream = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
    if (-not $stream) { return }

    $existing = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "cloudflared.exe" -and $_.CommandLine -like "*3001*"
    })
    if ($existing.Count -gt 0) { return }

    $cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
    if (-not (Test-Path $cloudflared)) {
        $cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source
    }
    Start-Process `
        -FilePath $cloudflared `
        -ArgumentList "tunnel --url http://127.0.0.1:3001" `
        -WorkingDirectory $projectPath `
        -WindowStyle Hidden `
        -RedirectStandardError (Join-Path $projectPath "cloudflared.stderr.log") `
        -RedirectStandardOutput (Join-Path $projectPath "cloudflared.stdout.log")
}

function Wait-ForCopiedCloudflareUrl {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        try {
            $clip = Get-Clipboard -Raw -ErrorAction Stop
        } catch {
            continue
        }
        $match = [regex]::Match($clip, $cloudflarePattern)
        if ($match.Success) {
            return $match.Value.Trim()
        }
    }
    return ""
}

try {
    if (-not (Test-Path $startScript)) {
        throw "No encontré start-mina.ps1 en $projectPath"
    }

    Restart-Mina
    Ensure-StreamTunnel

    $currentUrl = Get-EnvValue "VOICE_REMOTE_URL"
    if (Test-RemoteVoice $currentUrl) {
        Show-Info "MINA ya está encendida y la voz de Colab está funcionando.`n`nURL actual:`n$currentUrl"
        exit 0
    }

    if (Test-Path $referencePath) {
        Set-Clipboard -Value $referencePath
    }

    Start-Process $colabUrl

    Show-Info @"
Te abrí Google Colab.

1. Si te pide sesión, inicia sesión.
2. Activa GPU si no está activa.
3. Ejecuta la celda de Setup fijo si es una sesión nueva.
4. Después ejecuta la celda de Levantar API.
5. Si Colab pide archivo, sube:
$referencePath

Ya copié esa ruta al portapapeles.

Cuando Colab muestre VOICE_REMOTE_URL=https://..., copia esa línea o solo la URL.
Después presiona OK aquí y yo esperaré la URL, actualizaré .env y reiniciaré MINA.
"@

    $newUrl = Wait-ForCopiedCloudflareUrl
    if (-not $newUrl) {
        Show-Warn "No detecté ninguna URL de Cloudflare en el portapapeles durante $TimeoutMinutes minutos. Vuelve a ejecutar este acceso directo cuando tengas la URL."
        exit 1
    }

    Set-EnvValue "VOICE_REMOTE_URL" $newUrl
    Restart-Mina
    Ensure-StreamTunnel

    if (Test-RemoteVoice $newUrl) {
        Show-Info "Listo. MINA quedó usando Colab para la voz.`n`nNueva URL:`n$newUrl"
    } else {
        Show-Warn "Actualicé .env y reinicié MINA, pero la URL no respondió al /health.`n`nURL:`n$newUrl"
    }
} catch {
    Show-Warn "Error: $($_.Exception.Message)"
    exit 1
}
