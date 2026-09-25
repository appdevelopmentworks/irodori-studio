#!/usr/bin/env bash
# Stage what the macOS app bundles into resources/ (docs/architecture.md, "Packaging"):
#   resources/sidecar   the sidecar source, with the pinned irodori_tts next to app/ (D1, D3)
#   resources/uv        uv, pinned and checksum-verified
#   resources/ffmpeg    an LGPL ffmpeg built here from source - FFmpeg with LAME (MP3) and
#                       Opus, static, without GPL or non-free parts (D20) - with its
#                       license and BUILD.txt (versions and where the sources are)
# Binaries are ad-hoc signed (D14). tauri.conf.json bundles resources/ as the app's
# resource folder.
#
#   scripts/stage-runtime.sh [--sidecar-only]
#
# Needs an Apple Silicon Mac with the Xcode command line tools and pkg-config.
# Downloads and builds are kept in .stage/ (gitignored) and reused while checksums match.
set -euo pipefail

UV_VERSION=0.12.5
UV_SHA256=5bb0e5fe008a773c3dbcb97ff79cd89e1241464fe9d2f986d52ad8f1b037bd62
FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
LAME_VERSION=4.0
LAME_SHA256=3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb
OPUS_VERSION=1.6.1
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
# The oldest macOS the bundled binaries run on (the app targets 14+, with a margin).
export MACOSX_DEPLOYMENT_TARGET=13.0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCES="$ROOT/resources"
WORK="${STAGE_WORK:-$ROOT/.stage}"
JOBS="$(sysctl -n hw.ncpu)"
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

build_static() { # directory configure-arguments...
  local dir="$1"
  shift
  (cd "$dir" && ./configure --prefix="$WORK/prefix" --disable-shared --enable-static \
    --disable-dependency-tracking "$@" && make -j"$JOBS" && make install)
}

stage_ffmpeg() {
  clear_staged ffmpeg
  local src="$WORK/src" prefix="$WORK/prefix"
  rm -rf "$src" "$prefix"
  mkdir -p "$src" "$prefix"

  fetch "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz" \
    "$LAME_SHA256" "$WORK/lame-$LAME_VERSION.tar.gz"
  fetch "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" \
    "$OPUS_SHA256" "$WORK/opus-$OPUS_VERSION.tar.gz"
  fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
    "$FFMPEG_SHA256" "$WORK/ffmpeg-$FFMPEG_VERSION.tar.xz"

  tar -xzf "$WORK/lame-$LAME_VERSION.tar.gz" -C "$src"
  build_static "$src/lame-$LAME_VERSION" --disable-frontend
  tar -xzf "$WORK/opus-$OPUS_VERSION.tar.gz" -C "$src"
  build_static "$src/opus-$OPUS_VERSION" --disable-doc --disable-extra-programs

  # No autodetected libraries: nothing but the system's may end up linked.
  tar -xJf "$WORK/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$src"
  (
    cd "$src/ffmpeg-$FFMPEG_VERSION"
    PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure --prefix="$prefix" \
      --pkg-config-flags=--static \
      --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" \
      --disable-autodetect --enable-libmp3lame --enable-libopus \
      --disable-ffplay --disable-ffprobe --disable-doc --disable-network --disable-debug
    make -j"$JOBS"
  )

  local ffmpeg="$RESOURCES/ffmpeg/ffmpeg"
  install -m 755 "$src/ffmpeg-$FFMPEG_VERSION/ffmpeg" "$ffmpeg"
  cp "$src/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$RESOURCES/ffmpeg/LICENSE.txt"
  codesign --force --sign - "$ffmpeg"

  # LGPL only, nothing linked outside the system, and the encoders the app uses. (Outputs
  # are read whole first: an early-exiting grep in a pipe would trip pipefail.)
  local version encoders linked
  version="$("$ffmpeg" -hide_banner -version)"
  encoders="$("$ffmpeg" -hide_banner -encoders)"
  linked="$(otool -L "$ffmpeg" | tail -n +2)"
  if grep -qE -- '--enable-(gpl|nonfree)' <<<"$version"; then
    echo "the ffmpeg build is not LGPL" >&2
    exit 1
  fi
  if grep -vqE '^[[:space:]]*/(usr/lib|System/Library)/' <<<"$linked"; then
    echo "$linked" >&2
    echo "ffmpeg links a library outside the system" >&2
    exit 1
  fi
  for encoder in libmp3lame libopus aac flac; do
    grep -q " $encoder " <<<"$encoders" || {
      echo "ffmpeg lacks the $encoder encoder" >&2
      exit 1
    }
  done

  cat > "$RESOURCES/ffmpeg/BUILD.txt" <<EOF
FFmpeg bundled with irodori-studio (macOS arm64)

Built by scripts/stage-runtime.sh from these sources (static, macOS $MACOSX_DEPLOYMENT_TARGET+):
  FFmpeg $FFMPEG_VERSION  https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz  (sha256 $FFMPEG_SHA256)
  LAME $LAME_VERSION      https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz  (sha256 $LAME_SHA256)
  Opus $OPUS_VERSION    https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz  (sha256 $OPUS_SHA256)
$(grep "^configuration:" <<<"$version")

License: GNU Lesser General Public License 2.1 or later (LICENSE.txt); built without GPL
or non-free components. LAME is LGPL-2.0-or-later, Opus is BSD-3-Clause.
EOF
  echo "ffmpeg -> $RESOURCES/ffmpeg ($(head -n 1 <<<"$version"))"
}

stage_sidecar
if [[ "${1:-}" != "--sidecar-only" ]]; then
  stage_uv
  stage_ffmpeg
fi
echo "staged resources: $(find "$RESOURCES" -type f ! -name .gitkeep | wc -l | tr -d ' ') files, $(du -sh "$RESOURCES" | cut -f 1)"
