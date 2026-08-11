# Continue the full storyboard pipeline: clean stale assets, generate images, videos, and final film.
# Works with the web server endpoints (starts one automatically if none is running).
param(
    [string]$BaseUrl = 'http://localhost:5173',
    [string]$LogFile = "$PSScriptRoot\continue_full.log",
    [string]$Voice = 'female',
    [string]$Language = 'en'
)
$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $PSScriptRoot

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
}

function Invoke-Api($path, $bodyObj = @{}) {
    $body = $bodyObj | ConvertTo-Json -Compress
    return Invoke-RestMethod -Uri "$BaseUrl$path" -Method Post -Headers @{'Content-Type'='application/json'} -Body $body -TimeoutSec 30
}

function Wait-Phase($expected, $maxMin = 90) {
    $deadline = (Get-Date).AddMinutes($maxMin)
    $sawExpected = $false
    Start-Sleep -Seconds 2
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        try {
            $s = Invoke-RestMethod -Uri "$BaseUrl/api/status" -TimeoutSec 15
            $failed = ($s.failed -join ',')
            Write-Log "status: phase=$($s.phase) done=$($s.done)/$($s.total) ok=$($s.ok) failed=[$failed]"
            if ($s.phase -eq $expected) { $sawExpected = $true }
            if ($s.phase -eq 'idle' -and $sawExpected) { return $s }
            # Also accept idle immediately if no work existed (phase never changed)
            if ($s.phase -eq 'idle' -and -not $sawExpected -and ([DateTime]::UtcNow -gt $deadline.AddMinutes(-$maxMin + 0.5))) { return $s }
        } catch { Write-Log "poll error: $($_.Exception.Message)" }
    }
    throw "Timed out waiting for phase '$expected' to finish (max ${maxMin}m)"
}

function Backup-OldAssets() {
    $ts = Get-Date -Format 'yyyyMMdd_HHmmss'
    $fb = Join-Path $ROOT "frames\backup_$ts"
    $vb = Join-Path $ROOT "video\backup_$ts"
    New-Item -ItemType Directory -Path $fb -Force | Out-Null
    New-Item -ItemType Directory -Path $vb -Force | Out-Null

    foreach ($pattern in @('frame_*.png', 'char_*.png')) {
        foreach ($item in Get-ChildItem -Path (Join-Path $ROOT 'frames') -Filter $pattern -ErrorAction SilentlyContinue) {
            Move-Item -LiteralPath $item.FullName -Destination $fb -ErrorAction SilentlyContinue
        }
    }
    foreach ($pattern in @('frame_*.mp4', 'narrated_*.mp4', 'narration_*.mp3', 'narr_chunk_*.mp3', 'full_narration.mp3', 'narr_chunk_sig.txt', 'final_story.mp4')) {
        foreach ($item in Get-ChildItem -Path (Join-Path $ROOT 'video') -Filter $pattern -ErrorAction SilentlyContinue) {
            Move-Item -LiteralPath $item.FullName -Destination $vb -ErrorAction SilentlyContinue
        }
    }
    Write-Log "old assets backed up to: $fb and $vb"
}

try {
    Write-Log "working directory: $ROOT"
    Set-Location -LiteralPath $ROOT

    Backup-OldAssets

    # Ensure the web server is running
    $serverProc = $null
    try {
        $status = Invoke-RestMethod -Uri "$BaseUrl/api/status" -TimeoutSec 5
        Write-Log "using existing server at $BaseUrl"
    } catch {
        $node = (Get-Command node -ErrorAction Stop).Source
        $serverProc = Start-Process -FilePath $node -ArgumentList 'web/server.js' -WorkingDirectory $ROOT -PassThru -WindowStyle Hidden
        Write-Log "started server (pid $($serverProc.Id))"
        $started = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            try { $status = Invoke-RestMethod -Uri "$BaseUrl/api/status" -TimeoutSec 5; $started = $true; break }
            catch {}
        }
        if (-not $started) { throw 'server did not respond after starting' }
    }

    $frames = Get-Content (Join-Path $ROOT 'storyboard\frames.json') -Raw | ConvertFrom-Json
    $frameNumbers = @($frames | ForEach-Object { $_.frame })
    Write-Log "loaded $($frameNumbers.Count) frames: $($frameNumbers -join ',')"

    # Character reference portraits (optional; continues on failure)
    try {
        Write-Log 'starting character references...'
        Invoke-Api '/api/char-refs' @{}
        Wait-Phase 'char-refs' 30 | Out-Null
        Write-Log 'character references finished'
    } catch {
        Write-Log "character references failed or timed out: $($_.Exception.Message); continuing..."
    }

    # Generate frame images
    Write-Log "starting images for frames: $($frameNumbers -join ',')..."
    Invoke-Api '/api/images' @{ frames = $frameNumbers; imageModel = 'nano-banana-pro'; ratio = '16:9'; style = 'cinematic' }
    $imgStatus = Wait-Phase 'images' 120
    Write-Log "images finished: ok=$($imgStatus.ok) failed=[$($imgStatus.failed -join ',')]"

    # Generate frame videos
    Write-Log 'starting videos...'
    Invoke-Api '/api/videos' @{ ratio = '16:9' }
    $vidStatus = Wait-Phase 'videos' 300
    Write-Log "videos finished: ok=$($vidStatus.ok) failed=[$($vidStatus.failed -join ',')]"

    # Combine final film
    Write-Log 'starting final combine...'
    Invoke-Api '/api/combine' @{}
    Wait-Phase 'combining' 30 | Out-Null

    # Generate narration TTS and overlay it on the final film (Fish Audio by default)
    Write-Log 'starting narration...'
    Invoke-Api '/api/narration' @{ voice = $Voice; language = $Language; narrationEngine = 'fish'; force = $true }
    Wait-Phase 'narration' 20 | Out-Null

    $final = Join-Path $ROOT 'video\final_story.mp4'
    if (Test-Path $final) {
        $sizeMB = [math]::Round((Get-Item $final).Length / 1MB, 1)
        Write-Log "DONE: final film created -> $final (${sizeMB} MB)"
    } else {
        Write-Log 'WARNING: final film not found after combine'
    }
} catch {
    Write-Log "FATAL: $($_.Exception.Message)"
    throw
} finally {
    if ($serverProc) {
        Write-Log "stopping server pid $($serverProc.Id)"
        Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
    }
}
