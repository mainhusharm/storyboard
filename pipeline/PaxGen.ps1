# PaxSenix Storyboard Generation Pipeline
# Reads storyboard\frames.json -> submits async jobs -> polls -> downloads results.
#
# Usage:
#   powershell -File pipeline\PaxGen.ps1 -Phase images                # generate all frame images
#   powershell -File pipeline\PaxGen.ps1 -Phase videos                # animate frames via image-to-video
#   powershell -File pipeline\PaxGen.ps1 -Phase all                   # images then videos
#   powershell -File pipeline\PaxGen.ps1 -Phase images -Only 1,3,5    # specific frame numbers only
#
# frames.json schema: array of frame objects (see storyboard\frames.json)

param(
    [ValidateSet('images','videos','all')]
    [string]$Phase = 'images',

    [string]$FramesFile = "$PSScriptRoot\..\storyboard\frames.json",

    [int[]]$Only = @(),

    # Image model: nano-banana | nano-banana-pro | nano-banana-2
    [string]$ImageModel = 'nano-banana-pro',

    # Video model endpoint: veo-3.1 | grok-video | omni-flash
    [string]$VideoEndpoint = 'veo-3.1',

    [string]$Ratio = '16:9',

    [int]$PollIntervalSec = 10,
    [int]$MaxPollMinutes = 25
 )

$ErrorActionPreference = 'Stop'
$ApiKey = (Get-Content "$PSScriptRoot\apikey.txt" -Raw).Trim()
$Headers = @{ Authorization = "Bearer $ApiKey" }
$Base = 'https://api.paxsenix.org'
$FramesDir = "$PSScriptRoot\..\frames"
$VideoDir  = "$PSScriptRoot\..\video"
New-Item -ItemType Directory -Path $FramesDir -Force | Out-Null
New-Item -ItemType Directory -Path $VideoDir  -Force | Out-Null

$frames = Get-Content $FramesFile -Raw | ConvertFrom-Json
if ($Only.Count -gt 0) { $frames = $frames | Where-Object { $Only -contains $_.frame } }
Write-Host "Loaded $($frames.Count) frame(s) from $FramesFile"

function Submit-Job([string]$url) {
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            $r = Invoke-RestMethod -Uri $url -Headers $Headers -TimeoutSec 120
            if ($r.ok -and $r.task_url) { return $r.task_url }
            Write-Warning "Submit returned unexpected payload (attempt $attempt): $($r | ConvertTo-Json -Compress -Depth 3)"
        } catch {
            $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
            Write-Warning "Submit failed (attempt $attempt, HTTP $code): $($_.Exception.Message)"
            if ($code -eq 401) { throw "API key rejected (401). Aborting." }
        }
        Start-Sleep -Seconds (5 * $attempt)
    }
    return $null
}

function Wait-Job([string]$taskUrl, [int]$maxMin) {
    $deadline = (Get-Date).AddMinutes($maxMin)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri $taskUrl -Headers $Headers -TimeoutSec 60
            if ($r.status -eq 'done' -and $r.ok) {
                $u = $r.url
                if (-not $u -and $r.urls) { $u = $r.urls[0] }
                if (-not $u -and $r.video_url) { $u = $r.video_url }
                return $u
            }
            if ($r.status -match 'fail|error') { Write-Warning "Job failed: $($r | ConvertTo-Json -Compress -Depth 3)"; return $null }
        } catch {
            Write-Warning "Poll error: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds $PollIntervalSec
    }
    Write-Warning "Job timed out after $maxMin min: $taskUrl"
    return $null
}

function Save-File([string]$url, [string]$outPath) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try { Invoke-WebRequest -Uri $url -OutFile $outPath -UseBasicParsing -TimeoutSec 180; return $true }
        catch { Write-Warning "Download failed (attempt $attempt): $($_.Exception.Message)"; Start-Sleep -Seconds 4 }
    }
    return $false
}

# ---------------- IMAGE PHASE ----------------
if ($Phase -eq 'images' -or $Phase -eq 'all') {
    Write-Host "`n===== IMAGE GENERATION ($ImageModel, $Ratio) ====="
    $jobs = @()
    foreach ($f in $frames) {
        $out = Join-Path $FramesDir ("frame_{0:d2}.png" -f $f.frame)
        if (Test-Path $out) { Write-Host "frame $($f.frame): already exists, skipping"; continue }
        $prompt = $f.image_prompt
        $url = "$Base/ai-image/nano-banana?prompt=" + [uri]::EscapeDataString($prompt) + "&model=$ImageModel&ratio=$Ratio"
        $task = Submit-Job $url
        if ($task) { $jobs += [pscustomobject]@{ Frame = $f.frame; Task = $task; Out = $out }; Write-Host "frame $($f.frame): submitted" }
        else { Write-Warning "frame $($f.frame): SUBMIT FAILED" }
        Start-Sleep -Milliseconds 800   # be gentle with the API
    }
    $jsonDirty = $false
    foreach ($j in $jobs) {
        Write-Host "frame $($j.Frame): waiting..."
        $fileUrl = Wait-Job $j.Task $MaxPollMinutes
        if ($fileUrl -and (Save-File $fileUrl $j.Out)) {
            Write-Host "frame $($j.Frame): SAVED -> $($j.Out)"
            ($frames | Where-Object { $_.frame -eq $j.Frame }) | ForEach-Object {
                $_ | Add-Member -NotePropertyName generated_image_url -NotePropertyValue $fileUrl -Force
                $jsonDirty = $true
            }
        }
        else { Write-Warning "frame $($j.Frame): FAILED" }
    }
    # Persist generated image URLs so the video phase can use image-to-video
    if ($jsonDirty) { $frames | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $FramesFile; Write-Host "frames.json updated with image URLs" }
}

# ---------------- VIDEO PHASE ----------------
if ($Phase -eq 'videos' -or $Phase -eq 'all') {
    Write-Host "`n===== VIDEO GENERATION ($VideoEndpoint, image-to-video) ====="
    # PaxSenix video models reject unsupported ratios (omni-flash & veo-3.1 accept
    # only 16:9 / 9:16; grok-video adds 1:1; 4:3 is rejected by all). Snap unsupported
    # ratios for video so submissions never fail at submit time.
    $videoRatio = $Ratio
    $videoRatios = if ($VideoEndpoint -eq 'grok-video') { @('16:9','9:16','1:1') } else { @('16:9','9:16') }
    if ($videoRatios -notcontains $Ratio) {
        $w, $h = $Ratio -split ':' | ForEach-Object { try { [int]$_ } catch { 0 } }
        $videoRatio = if ($w -gt 0 -and $h -gt 0 -and $w -lt $h) { '9:16' } else { '16:9' }
        Write-Warning "Video model $VideoEndpoint does not support ratio $Ratio — using $videoRatio for video."
    }
    $jobs = @()
    foreach ($f in $frames) {
        if (-not $f.animation_prompt) { continue }
        $imgOut = Join-Path $FramesDir ("frame_{0:d2}.png" -f $f.frame)
        $vidOut = Join-Path $VideoDir ("frame_{0:d2}.mp4" -f $f.frame)
        if (Test-Path $vidOut) { Write-Host "frame $($f.frame): video exists, skipping"; continue }
        # Re-host frame image: veo needs a public URL. Re-upload via tmpfiles-compatible URL from frames dir is not public;
        # so videos use text-to-video unless an image_url was recorded during image phase.
        $imgUrl = $f.generated_image_url
        $mode = 'text-to-video'
        $imgParam = ''
        if ($imgUrl) { $mode = 'image-to-video'; $imgParam = '&imageUrl=' + [uri]::EscapeDataString($imgUrl) }
        $url = "$Base/ai-video/$VideoEndpoint?prompt=" + [uri]::EscapeDataString($f.animation_prompt) + "&ratio=$videoRatio&type=$mode$imgParam"
        $task = Submit-Job $url
        if ($task) { $jobs += [pscustomobject]@{ Frame = $f.frame; Task = $task; Out = $vidOut }; Write-Host "frame $($f.frame): submitted ($mode)" }
        else { Write-Warning "frame $($f.frame): SUBMIT FAILED" }
        Start-Sleep -Milliseconds 800
    }
    foreach ($j in $jobs) {
        Write-Host "frame $($j.Frame): waiting for video..."
        $fileUrl = Wait-Job $j.Task $MaxPollMinutes
        if ($fileUrl -and (Save-File $fileUrl $j.Out)) { Write-Host "frame $($j.Frame): SAVED -> $($j.Out)" }
        else { Write-Warning "frame $($j.Frame): FAILED" }
    }
}

Write-Host "`nPipeline finished."
