# Stage what the Windows app bundles into resources\ (docs/architecture.md, "Packaging"):
#   resources\sidecar   the sidecar source, with the pinned irodori_tts next to app\ (D1, D3)
#   resources\uv        uv.exe, pinned and checksum-verified
#   resources\ffmpeg    ffmpeg.exe from BtbN's LGPL build of the FFmpeg 9.0 branch (D20),
#                       with its license and BUILD.txt (the build used and its source)
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
# BtbN rebuilds the release branches daily; the digest is read from the release itself.
$FfmpegAsset = 'ffmpeg-n9.0-latest-win64-lgpl-9.0.zip'
$FfmpegRelease = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest'

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
    $headers = @{ 'User-Agent' = 'irodori-studio-stage' }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }
    $release = Invoke-RestMethod -Uri $FfmpegRelease -Headers $headers
    $asset = $release.assets | Where-Object { $_.name -eq $FfmpegAsset } | Select-Object -First 1
    if (-not $asset) { throw "asset not found in $($release.tag_name): $FfmpegAsset" }
    if ($asset.digest -notmatch '^sha256:([0-9a-f]{64})$') { throw "no sha256 digest for $FfmpegAsset" }
    $sha256 = $Matches[1]
    $archive = Join-Path $Work $FfmpegAsset
    Get-Verified $asset.browser_download_url $sha256 $archive

    $unpacked = Join-Path $Work 'ffmpeg'
    if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
    Expand-Archive -Path $archive -DestinationPath $unpacked
    $exe = Get-ChildItem -Path $unpacked -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    $license = Get-ChildItem -Path $unpacked -Recurse -Filter 'LICENSE.txt' | Select-Object -First 1
    Copy-Item -Path $exe.FullName -Destination (Join-Path $dest 'ffmpeg.exe')
    Copy-Item -Path $license.FullName -Destination (Join-Path $dest 'LICENSE.txt')

    # The build must be LGPL: no --enable-gpl / --enable-nonfree.
    $ffmpeg = Join-Path $dest 'ffmpeg.exe'
    $info = (& $ffmpeg -hide_banner -version) -join "`n"
    if ($info -match '--enable-(gpl|nonfree)') { throw 'the ffmpeg build is not LGPL' }
    foreach ($encoder in @('libmp3lame', 'libopus', 'aac', 'flac')) {
        $found = & $ffmpeg -hide_banner -encoders | Select-String -SimpleMatch " $encoder "
        if (-not $found) { throw "ffmpeg lacks the $encoder encoder" }
    }

    $versionLine = ($info -split "`n")[0]
    $configuration = ($info -split "`n" | Where-Object { $_ -like 'configuration:*' }) -join ''
    # --enable-version3 (BtbN's builds) makes it LGPL 3; otherwise LGPL 2.1.
    $lgpl = if ($configuration -match '--enable-version3') { '3' } else { '2.1' }
    $build = @(
        'FFmpeg bundled with irodori-studio (Windows x64)',
        '',
        "Build:   $FfmpegAsset from https://github.com/BtbN/FFmpeg-Builds ($($release.tag_name), $($asset.updated_at))",
        "SHA-256: $sha256",
        "Version: $versionLine",
        $configuration,
        '',
        "License: GNU Lesser General Public License $lgpl or later (LICENSE.txt); built without",
        'GPL or non-free components. Source: the FFmpeg revision in the version line, at',
        'https://github.com/FFmpeg/FFmpeg, and the build scripts at',
        'https://github.com/BtbN/FFmpeg-Builds.'
    )
    Set-Content -Path (Join-Path $dest 'BUILD.txt') -Value $build -Encoding ASCII
    Write-Host "ffmpeg -> $dest ($versionLine)"
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
