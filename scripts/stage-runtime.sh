#!/usr/bin/env bash
# Stage what the macOS app bundles into resources/ (docs/architecture.md, "Packaging"):
#   resources/sidecar   the sidecar source, with the pinned irodori_tts next to app/ (D1, D3)
#   resources/uv        uv, pinned and checksum-verified
#   resources/ffmpeg    the audio-only LGPL ffmpeg (FFmpeg + LAME + Opus) that
#                       .github/workflows/ffmpeg.yml builds and publishes with its sources
#                       (D20), with its license files and BUILD.txt, checksum-verified
# Binaries are ad-hoc signed (D14). tauri.conf.json bundles resources/ as the app's
# resource folder.
#
#   scripts/stage-runtime.sh [--sidecar-only]
#
# Needs an Apple Silicon Mac. Downloads are kept in .stage/ (gitignored) and reused while
# their checksum matches.
set -euo pipefail

UV_VERSION=0.12.5
UV_SHA256=5bb0e5fe008a773c3dbcb97ff79cd89e1241464fe9d2f986d52ad8f1b037bd62
# Built by scripts/build-ffmpeg.sh; bump with a new run of ffmpeg.yml.
FFMPEG_TAG=ffmpeg-9.0.2-1
FFMPEG_SHA256=11389c416fcc5b1d8f477ae9d5aa4ae46f3f48e13b694bd6e918dd709c41ea75
FFMPEG_URL="https://github.com/appdevelopmentworks/irodori-studio/releases/download/$FFMPEG_TAG/ffmpeg-macos-arm64.zip"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCES="$ROOT/resources"
WORK="${STAGE_WORK:-$ROOT/.stage}"
mkdir -p "$WORK"

clear_staged() {
  mkdir -p "$RESOURCES/$1"
  find "$RESOURCES/$1" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf {} +
}

sha256_ok() {
  [[ -f "$1" ]] && [[ "$(shasum -a 256 "$1" | cut -d ' ' -f 1)" == "$2" ]]
}

fetch() { # url sha256 destination
  if ! sha256_ok "$3" "$2"; then
    echo "download $1"
    curl -fL --retry 3 -o "$3.part" "$1"
    mv "$3.part" "$3"
  fi
  sha256_ok "$3" "$2" || { echo "checksum mismatch: $1" >&2; exit 1; }
}

copy_tree() { # source destination
  rsync -a --exclude '__pycache__' --exclude '.pytest_cache' --exclude '.ruff_cache' "$1" "$2"
}

stage_sidecar() {
  clear_staged sidecar
  local dest="$RESOURCES/sidecar" source="$ROOT/sidecar"
  copy_tree "$source/app" "$dest/"
  for name in pyproject.toml uv.lock .python-version models.json upstream.json; do
    cp "$source/$name" "$dest/"
  done
  # Installed builds import irodori_tts from the sidecar folder (layout.rs), unmodified.
  copy_tree "$ROOT/third_party/Irodori-TTS/irodori_tts" "$dest/"
  cp "$ROOT/third_party/Irodori-TTS/LICENSE" "$dest/irodori_tts/LICENSE"
  echo "sidecar -> $dest"
}

stage_uv() {
  clear_staged uv
  local archive="$WORK/uv-$UV_VERSION-aarch64-apple-darwin.tar.gz"
  fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz" \
    "$UV_SHA256" "$archive"
  rm -rf "$WORK/uv-aarch64-apple-darwin"
  tar -xzf "$archive" -C "$WORK"
  install -m 755 "$WORK/uv-aarch64-apple-darwin/uv" "$RESOURCES/uv/uv"
  codesign --force --sign - "$RESOURCES/uv/uv"
  echo "uv -> $RESOURCES/uv ($("$RESOURCES/uv/uv" --version))"
}

stage_ffmpeg() {
  clear_staged ffmpeg
  local archive="$WORK/$FFMPEG_TAG-macos-arm64.zip"
  fetch "$FFMPEG_URL" "$FFMPEG_SHA256" "$archive"
  # ffmpeg, LICENSE.txt, LICENSE-lame.txt, LICENSE-opus.txt and BUILD.txt, as published.
  unzip -q -o "$archive" -d "$RESOURCES/ffmpeg"
  local ffmpeg="$RESOURCES/ffmpeg/ffmpeg"
  chmod 755 "$ffmpeg"
  codesign --force --sign - "$ffmpeg"

  # LGPL only, with the encoders the app uses. (Outputs are read whole first: an
  # early-exiting grep in a pipe would trip pipefail.)
  local version encoders
  version="$("$ffmpeg" -hide_banner -version)"
  encoders="$("$ffmpeg" -hide_banner -encoders)"
  if grep -qE -- '--enable-(gpl|nonfree)' <<<"$version"; then
    echo "the ffmpeg build is not LGPL" >&2
    exit 1
  fi
  for encoder in libmp3lame libopus aac flac; do
    grep -q " $encoder " <<<"$encoders" || {
      echo "ffmpeg lacks the $encoder encoder" >&2
      exit 1
    }
  done
  echo "ffmpeg -> $RESOURCES/ffmpeg ($(head -n 1 <<<"$version"))"
}

stage_sidecar
if [[ "${1:-}" != "--sidecar-only" ]]; then
  stage_uv
  stage_ffmpeg
fi
echo "staged resources: $(find "$RESOURCES" -type f ! -name .gitkeep | wc -l | tr -d ' ') files, $(du -sh "$RESOURCES" | cut -f 1)"
