#!/usr/bin/env bash
# Builds the audio-only LGPL ffmpeg that installers bundle (D20): FFmpeg with LAME (MP3) and
# Opus, statically linked, no other external library, without GPL or non-free parts. Runs on
# macOS (arm64) and in MSYS2's UCRT64 shell on Windows (x64); .github/workflows/ffmpeg.yml
# builds both and publishes them, with these sources, for the stage scripts to download.
#
#   scripts/build-ffmpeg.sh <out-dir>            ffmpeg[.exe], LICENSE.txt (FFmpeg's LGPL 2.1),
#                                                LICENSE-lame.txt, LICENSE-opus.txt, BUILD.txt
#   scripts/build-ffmpeg.sh --sources <out-dir>  only the verified source archives
#
# Needs a C compiler, make, pkg-config and curl (and nasm on Windows). Downloads are kept in
# .stage/ffmpeg-src (gitignored) and checked against the checksums below. FFMPEG_RELEASE_URL,
# when set, is where the published build and its sources are (recorded in BUILD.txt).
set -euo pipefail

FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
LAME_VERSION=4.0
LAME_SHA256=3df5124d5ad3a98312ffd7ba6a9b36230e4f8a3e66d3ce0f425e336c32d216eb
OPUS_VERSION=1.6.1
OPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1

FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"
OPUS_URL="https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz"

SOURCES_ONLY=false
if [[ "${1:-}" == "--sources" ]]; then
  SOURCES_ONLY=true
  shift
fi
[[ $# -eq 1 ]] || { echo "usage: $0 [--sources] <out-dir>" >&2; exit 2; }
mkdir -p "$1"
OUT="$(cd "$1" && pwd)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${STAGE_WORK:-$ROOT/.stage}/ffmpeg-src"
mkdir -p "$WORK"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1
}

fetch() { # url sha256 destination
  if [[ ! -f "$3" ]] || [[ "$(sha256 "$3")" != "$2" ]]; then
    echo "download $1"
    curl -fL --retry 3 -o "$3.part" "$1"
    mv "$3.part" "$3"
  fi
  [[ "$(sha256 "$3")" == "$2" ]] || { echo "checksum mismatch: $1" >&2; exit 1; }
}

fetch "$FFMPEG_URL" "$FFMPEG_SHA256" "$WORK/ffmpeg-$FFMPEG_VERSION.tar.xz"
fetch "$LAME_URL" "$LAME_SHA256" "$WORK/lame-$LAME_VERSION.tar.gz"
fetch "$OPUS_URL" "$OPUS_SHA256" "$WORK/opus-$OPUS_VERSION.tar.gz"
if $SOURCES_ONLY; then
  cp "$WORK/ffmpeg-$FFMPEG_VERSION.tar.xz" "$WORK/lame-$LAME_VERSION.tar.gz" \
    "$WORK/opus-$OPUS_VERSION.tar.gz" "$OUT/"
  echo "sources -> $OUT"
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    PLATFORM="macOS arm64"
    EXE=""
    JOBS="$(sysctl -n hw.ncpu)"
    # The oldest macOS the binary runs on (the app targets 14+, with a margin).
    export MACOSX_DEPLOYMENT_TARGET=13.0
    PLATFORM_FLAGS=(--enable-pthreads)
    LAME_CFLAGS=""
    ;;
  UCRT64_NT* | MINGW64_NT*)
    PLATFORM="Windows x64"
    EXE=".exe"
    JOBS="$(nproc)"
    # -static: no MinGW runtime DLLs next to ffmpeg.exe.
    PLATFORM_FLAGS=(--enable-w32threads --extra-ldflags=-static)
    # GCC 14+ turns old-C diagnostics into errors; -fpermissive makes them warnings again.
    LAME_CFLAGS="-fpermissive"
    ;;
  *)
    echo "build-ffmpeg: run on macOS or in MSYS2's UCRT64 shell" >&2
    exit 1
    ;;
esac

SRC="$WORK/build"
PREFIX="$WORK/prefix"
rm -rf "$SRC" "$PREFIX"
mkdir -p "$SRC" "$PREFIX"

build_static() { # directory configure-arguments...
  local dir="$1"
  shift
  (
    cd "$dir"
    ./configure --prefix="$PREFIX" --disable-shared --enable-static \
      --disable-dependency-tracking "$@" || { tail -n 40 config.log >&2; exit 1; }
    make -j"$JOBS"
    make install
  )
}

tar -xzf "$WORK/lame-$LAME_VERSION.tar.gz" -C "$SRC"
# The encoder only: FFmpeg decodes MP3 itself, and LAME's decoder needs libmpg123. LAME's
# older code does not build as C23, the default of recent compilers (as in Homebrew's formula).
build_static "$SRC/lame-$LAME_VERSION" --disable-frontend --disable-decoder \
  ac_cv_prog_cc_c23=no CFLAGS="-O2 -std=gnu17 -Wno-implicit-function-declaration $LAME_CFLAGS"
tar -xzf "$WORK/opus-$OPUS_VERSION.tar.gz" -C "$SRC"
build_static "$SRC/opus-$OPUS_VERSION" --disable-doc --disable-extra-programs

# --disable-autodetect: no library is picked up from the build machine, threads included
# (enabled per platform above), so nothing but the system's may end up linked. No avdevice:
# the app captures nothing, and on Windows it would link the capture APIs.
tar -xJf "$WORK/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$SRC"
(
  cd "$SRC/ffmpeg-$FFMPEG_VERSION"
  PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure --prefix="$PREFIX" \
    --pkg-config-flags=--static \
    --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" \
    --disable-autodetect "${PLATFORM_FLAGS[@]}" \
    --enable-libmp3lame --enable-libopus \
    --disable-avdevice --disable-ffplay --disable-ffprobe --disable-doc --disable-network \
    --disable-debug || { tail -n 60 ffbuild/config.log >&2; exit 1; }
  make -j"$JOBS"
)

ffmpeg="$OUT/ffmpeg$EXE"
rm -f "$OUT"/ffmpeg* "$OUT"/LICENSE*.txt "$OUT/BUILD.txt"
install -m 755 "$SRC/ffmpeg-$FFMPEG_VERSION/ffmpeg$EXE" "$ffmpeg"
cp "$SRC/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$OUT/LICENSE.txt"
# Opus's BSD license asks for its notice with the binary; LAME's LGPL text goes along.
cp "$SRC/opus-$OPUS_VERSION/COPYING" "$OUT/LICENSE-opus.txt"
cp "$SRC/lame-$LAME_VERSION/COPYING" "$OUT/LICENSE-lame.txt"
if [[ -z "$EXE" ]]; then
  codesign --force --sign - "$ffmpeg"
fi

# LGPL only, the encoders the app uses, and nothing linked outside the system. (Outputs are
# read whole first: an early-exiting grep in a pipe would trip pipefail.)
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
if [[ -z "$EXE" ]]; then
  linked="$(otool -L "$ffmpeg" | tail -n +2)"
  if grep -vqE '^[[:space:]]*/(usr/lib|System/Library)/' <<<"$linked"; then
    echo "$linked" >&2
    echo "ffmpeg links a library outside the system" >&2
    exit 1
  fi
else
  # Every imported DLL must be part of Windows: an API set, or a file in System32.
  linked="$(objdump -p "$ffmpeg" | sed -n 's/^[[:space:]]*DLL Name: //p')"
  system32="$(cygpath -u "${SYSTEMROOT:-C:/Windows}")/System32"
  foreign=""
  shopt -s nocasematch
  while read -r dll; do
    [[ -z "$dll" || "$dll" == api-ms-win-* || -f "$system32/$dll" ]] || foreign+=" $dll"
  done <<<"$linked"
  shopt -u nocasematch
  if [[ -n "$foreign" ]]; then
    echo "ffmpeg.exe links DLLs that are not part of Windows:$foreign" >&2
    exit 1
  fi
fi

cat >"$OUT/BUILD.txt" <<EOF
FFmpeg bundled with irodori-studio ($PLATFORM)

Built by scripts/build-ffmpeg.sh from these sources, statically linked:
  FFmpeg $FFMPEG_VERSION  $FFMPEG_URL
    sha256 $FFMPEG_SHA256
  LAME $LAME_VERSION  $LAME_URL
    sha256 $LAME_SHA256
  Opus $OPUS_VERSION  $OPUS_URL
    sha256 $OPUS_SHA256
${FFMPEG_RELEASE_URL:+The same source archives are published with this build: $FFMPEG_RELEASE_URL
}
$(head -n 1 <<<"$version")
$(grep "^configuration:" <<<"$version")

License: GNU Lesser General Public License 2.1 or later (LICENSE.txt); built without GPL
or non-free components. LAME is LGPL-2.0-or-later (LICENSE-lame.txt); Opus is
BSD-3-Clause (LICENSE-opus.txt).
EOF
echo "ffmpeg -> $OUT ($(head -n 1 <<<"$version"), $(du -h "$ffmpeg" | cut -f 1))"
