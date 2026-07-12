param(
    [ValidateSet("Panel", "Start", "Stop", "Restart", "Status")]
    [string]$Mode = "Panel"
)

$ErrorActionPreference = "Stop"

$projectPath = $PSScriptRoot
$stdout = Join-Path $projectPath "bot.stdout.log"
$stderr = Join-Path $projectPath "bot.stderr.log"
$envPath = Join-Path $projectPath ".env"
$voicePython = "C:\mina-voice-venv\Scripts\python.exe"

Add-Type -AssemblyName PresentationFramework

function Get-MinaProcess {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "node.exe" -and $_.CommandLine -like "*dist/index.js*"
    })
}

function Stop-ProcessTree([int]$ProcessId) {
    $children = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ParentProcessId -eq $ProcessId
    })
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId $child.ProcessId
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Start-Mina {
    if (Get-MinaProcess) {
        return "MINA ya estaba encendida."
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process `
        -FilePath $node `
        -ArgumentList "dist/index.js" `
        -WorkingDirectory $projectPath `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr
    Start-Sleep -Seconds 2
    if (Get-MinaProcess) {
        return "MINA se encendió correctamente."
    }
    return "No se pudo encender MINA. Revisa bot.stderr.log."
}

function Stop-Mina {
    $processes = Get-MinaProcess
    if (-not $processes) {
        return "MINA ya estaba apagada."
    }
    foreach ($process in $processes) {
        Stop-ProcessTree -ProcessId $process.ProcessId
    }
    Start-Sleep -Milliseconds 500
    return "MINA se apagó correctamente."
}

function Restart-Mina {
    Stop-Mina | Out-Null
    Start-Sleep -Seconds 1
    Start-Mina
}

function Get-EnvValue([string]$Name) {
    if (-not (Test-Path $envPath)) { return "" }
    $line = Select-String -LiteralPath $envPath -Pattern "^$([regex]::Escape($Name))=" | Select-Object -First 1
    if (-not $line) { return "" }
    return $line.Line.Split("=", 2)[1].Trim()
}

function Get-VoiceStatus {
    $remoteUrl = Get-EnvValue "VOICE_REMOTE_URL"
    if ($remoteUrl) {
        try {
            $health = Invoke-RestMethod -Uri ($remoteUrl.TrimEnd("/") + "/health") -TimeoutSec 5
            if ($health.ok) {
                if ($health.device -eq "cuda") {
                    return @{
                        Text = "Voz IA: Google Colab GPU"
                        Color = "#38D27A"
                    }
                }
                return @{
                    Text = "Voz IA: Google Colab CPU"
                    Color = "#F0B94A"
                }
            }
        } catch {
            # Si Colab no responde, revisamos si la voz local está disponible.
        }
    }

    if (Test-Path $voicePython) {
        try {
            $device = & $voicePython -c "import torch; print('cuda' if torch.cuda.is_available() else 'cpu')" 2>$null
            if (($device | Select-Object -First 1) -eq "cuda") {
                return @{
                    Text = "Voz IA: GPU local"
                    Color = "#7C8CFF"
                }
            }
            return @{
                Text = "Voz IA: CPU local"
                Color = "#F0B94A"
            }
        } catch {
            # Seguimos al estado no disponible.
        }
    }

    return @{
        Text = "Voz IA: no disponible"
        Color = "#E05266"
    }
}

if ($Mode -ne "Panel") {
    switch ($Mode) {
        "Start" { Start-Mina }
        "Stop" { Stop-Mina }
        "Restart" { Restart-Mina }
        "Status" {
            if (Get-MinaProcess) { "Encendida" } else { "Apagada" }
        }
    }
    exit 0
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Title="Control de MINA"
        Width="390"
        Height="310"
        ResizeMode="NoResize"
        WindowStartupLocation="CenterScreen"
        Background="#17181D">
    <Grid Margin="24">
        <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
            <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>

        <TextBlock Text="MINA Discord Bot"
                   Foreground="White"
                   FontSize="25"
                   FontWeight="SemiBold"/>

        <StackPanel Grid.Row="1"
                Margin="0,14,0,20"
                Orientation="Vertical">
            <Border Padding="12,8"
                    CornerRadius="8"
                    Background="#24262E">
                <StackPanel Orientation="Horizontal">
                    <Ellipse Name="StatusDot" Width="10" Height="10" Margin="0,0,9,0"/>
                    <TextBlock Name="StatusText" Foreground="#D8DAE3" FontSize="14"/>
                </StackPanel>
            </Border>
            <Border Margin="0,8,0,0"
                    Padding="12,8"
                    CornerRadius="8"
                    Background="#24262E">
                <StackPanel Orientation="Horizontal">
                    <Ellipse Name="VoiceDot" Width="10" Height="10" Margin="0,0,9,0"/>
                    <TextBlock Name="VoiceText" Foreground="#D8DAE3" FontSize="14"/>
                </StackPanel>
            </Border>
        </StackPanel>

        <UniformGrid Grid.Row="2" Columns="3">
            <Button Name="StartButton" Content="▶  Encender" Margin="0,0,6,0"
                    Background="#248A55" Foreground="White" BorderThickness="0"
                    FontWeight="SemiBold" Cursor="Hand"/>
            <Button Name="StopButton" Content="■  Apagar" Margin="3,0"
                    Background="#A83246" Foreground="White" BorderThickness="0"
                    FontWeight="SemiBold" Cursor="Hand"/>
            <Button Name="RestartButton" Content="↻  Reiniciar" Margin="6,0,0,0"
                    Background="#5865F2" Foreground="White" BorderThickness="0"
                    FontWeight="SemiBold" Cursor="Hand"/>
        </UniformGrid>

        <TextBlock Grid.Row="3" Name="ResultText"
                   Margin="0,18,0,0"
                   Foreground="#AEB2C0"
                   TextAlignment="Center"
                   TextWrapping="Wrap"/>
    </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$statusDot = $window.FindName("StatusDot")
$statusText = $window.FindName("StatusText")
$voiceDot = $window.FindName("VoiceDot")
$voiceText = $window.FindName("VoiceText")
$resultText = $window.FindName("ResultText")
$startButton = $window.FindName("StartButton")
$stopButton = $window.FindName("StopButton")
$restartButton = $window.FindName("RestartButton")

function Update-Status {
    if (Get-MinaProcess) {
        $statusDot.Fill = "#38D27A"
        $statusText.Text = "MINA está encendida"
    } else {
        $statusDot.Fill = "#E05266"
        $statusText.Text = "MINA está apagada"
    }

    $voice = Get-VoiceStatus
    $voiceDot.Fill = $voice.Color
    $voiceText.Text = $voice.Text
}

function Invoke-PanelAction([scriptblock]$Action) {
    $startButton.IsEnabled = $false
    $stopButton.IsEnabled = $false
    $restartButton.IsEnabled = $false
    $resultText.Text = "Procesando..."
    $window.Dispatcher.Invoke(
        [System.Windows.Threading.DispatcherPriority]::Background,
        [action]{}
    )
    try {
        $resultText.Text = (& $Action | Out-String).Trim()
    } catch {
        $resultText.Text = "Error: $($_.Exception.Message)"
    } finally {
        Update-Status
        $startButton.IsEnabled = $true
        $stopButton.IsEnabled = $true
        $restartButton.IsEnabled = $true
    }
}

$startButton.Add_Click({
    Invoke-PanelAction { Start-Mina }
})

$stopButton.Add_Click({
    Invoke-PanelAction { Stop-Mina }
})

$restartButton.Add_Click({
    Invoke-PanelAction { Restart-Mina }
})

Update-Status
$window.ShowDialog() | Out-Null
