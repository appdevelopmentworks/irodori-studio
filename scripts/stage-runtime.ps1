# Stage what the Windows app bundles into resources\ (docs/architecture.md, "Packaging"):
#   resources\sidecar   the sidecar source, with the pinned irodori_tts next to app\ (D1, D3)
#   resources\uv        uv.exe, pinned and checksum-verified
#   resources\ffmpeg    the audio-only LGPL ffmpeg (FFmpeg + LAME + Opus) that
#                       .github/workflows/ffmpeg.yml builds and publishes with its sources
#                       (D20), with its license files and BUILD.txt, checksum-verified
# tauri.conf.json bundles resources\ as the app's resource folder.
#
#   powershell -ExecutionPolicy Bypass -File scripts\stage-runtime.ps1 [-SidecarOnly]
#
# Downloads are kept in .stage\ (gitignored) and reused while their checksum matches.
# Keep this file ASCII: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

[CmdletBinding()]
param(
    # Stage only the sidecar (no downloads).
    [switch]$SidecarOnly
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is very slow with its progress bar.
$ProgressPreference = 'SilentlyContinue'

$UvVersion = '0.12.5'
$UvSha256 = '4c4d49d8738847d9b71ba319e49a5688c93eac0fe6204b1df24e98528dddf39a'
# Built by scripts/build-ffmpeg.sh; bump with a new run of ffmpeg.yml.
$FfmpegTag = 'ffmpeg-9.0.2-1'
$FfmpegSha256 = 'cd836051d545b705410623cf472bfefe66487da3e620b29a3ff2ab82752dcac2'
$FfmpegUrl = "https://github.com/appdevelopmentworks/irodori-studio/releases/download/$FfmpegTag/ffmpeg-windows-x64.zip"

$Root = Split-Path -Parent $PSScriptRoot
$Resources = Join-Path $Root 'resources'
$Work = if ($env:STAGE_WORK) { $env:STAGE_WORK } else { Join-Path $Root '.stage' }
New-Item -ItemType Directory -Force -Path $Work | Out-Null

function Clear-Staged([string]$Name) {
    $dir = Join-Path $Resources $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Get-ChildItem -Path $dir -Force | Where-Object { $_.Name -ne '.gitkeep' } |
        Remove-Item -Recurse -Force
    return $dir
}

function Test-Sha256([string]$Path, [string]$Sha256) {
    (Test-Path $Path) -and ((Get-FileHash -Path $Path -Algorithm SHA256).Hash -eq $Sha256.ToUpperInvariant())
}

function Get-Verified([string]$Url, [string]$Sha256, [string]$Destination) {
    if (-not (Test-Sha256 $Destination $Sha256)) {
        Write-Host "download $Url"
        Invoke-WebRequest -Uri $Url -OutFile "$Destination.part" -UseBasicParsing
        Move-Item -Force "$Destination.part" $Destination
    }
    if (-not (Test-Sha256 $Destination $Sha256)) {
        throw "checksum mismatch: $Url"
    }
}

function Copy-Tree([string]$From, [string]$To) {
    Copy-Item -Path $From -Destination $To -Recurse -Force
    Get-ChildItem -Path $To -Recurse -Force -Directory |
        Where-Object { $_.Name -in @('__pycache__', '.pytest_cache', '.ruff_cache') } |
        Remove-Item -Recurse -Force
}

function Stage-Sidecar {
    $dest = Clear-Staged 'sidecar'
    $source = Join-Path $Root 'sidecar'
    Copy-Tree (Join-Path $source 'app') $dest
    foreach ($name in @('pyproject.toml', 'uv.lock', '.python-version', 'models.json', 'upstream.json')) {
        Copy-Item -Path (Join-Path $source $name) -Destination $dest
    }
    # Installed builds import irodori_tts from the sidecar folder (layout.rs), unmodified.
    $upstream = Join-Path $Root 'third_party\Irodori-TTS'
    Copy-Tree (Join-Path $upstream 'irodori_tts') $dest
    Copy-Item -Path (Join-Path $upstream 'LICENSE') -Destination (Join-Path $dest 'irodori_tts\LICENSE')
    Write-Host "sidecar -> $dest"
}

function Stage-Uv {
    $dest = Clear-Staged 'uv'
    $archive = Join-Path $Work "uv-$UvVersion-x86_64-pc-windows-msvc.zip"
    $url = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
    Get-Verified $url $UvSha256 $archive
    $unpacked = Join-Path $Work "uv-$UvVersion"
    if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
    Expand-Archive -Path $archive -DestinationPath $unpacked
    $exe = Get-ChildItem -Path $unpacked -Recurse -Filter 'uv.exe' | Select-Object -First 1
    Copy-Item -Path $exe.FullName -Destination (Join-Path $dest 'uv.exe')
    $version = & (Join-Path $dest 'uv.exe') --version
    Write-Host "uv -> $dest ($version)"
}

function Stage-Ffmpeg {
    $dest = Clear-Staged 'ffmpeg'
    $archive = Join-Path $Work "$FfmpegTag-windows-x64.zip"
    Get-Verified $FfmpegUrl $FfmpegSha256 $archive
    $unpacked = Join-Path $Work 'ffmpeg'
    if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
    Expand-Archive -Path $archive -DestinationPath $unpacked
    # ffmpeg.exe, LICENSE.txt, LICENSE-lame.txt, LICENSE-opus.txt and BUILD.txt, as published.
    Copy-Item -Path (Join-Path $unpacked '*') -Destination $dest

    # The build must be LGPL (no --enable-gpl / --enable-nonfree) with the encoders the app uses.
    $ffmpeg = Join-Path $dest 'ffmpeg.exe'
    $info = (& $ffmpeg -hide_banner -version) -join "`n"
    if ($info -match '--enable-(gpl|nonfree)') { throw 'the ffmpeg build is not LGPL' }
    foreach ($encoder in @('libmp3lame', 'libopus', 'aac', 'flac')) {
        $found = & $ffmpeg -hide_banner -encoders | Select-String -SimpleMatch " $encoder "
        if (-not $found) { throw "ffmpeg lacks the $encoder encoder" }
    }
    Write-Host "ffmpeg -> $dest ($(($info -split "`n")[0]))"
}

Stage-Sidecar
if (-not $SidecarOnly) {
    Stage-Uv
    Stage-Ffmpeg
}
Write-Host 'staged resources:'
Get-ChildItem -Path $Resources -Recurse -File |
    Where-Object { $_.Name -ne '.gitkeep' } |
    Measure-Object -Property Length -Sum |
    ForEach-Object { Write-Host ("  {0} files, {1:N1} MB" -f $_.Count, ($_.Sum / 1MB)) }
