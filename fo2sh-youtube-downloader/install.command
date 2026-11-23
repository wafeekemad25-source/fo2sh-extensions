#!/bin/bash
# Fo2sh YouTube Downloader - one-time setup for macOS.
# Installs yt-dlp + ffmpeg into ~/Library/Application Support/Fo2sh
# and connects them to Chrome / Edge / Brave / Arc / Chromium.
# Safe to run again any time (to repair or update).

EXT_ID="fmjnoaogndcfkhkfjpoodmamkimegcae"
HOST_NAME="com.fo2sh.ytdl"
DIR="$HOME/Library/Application Support/Fo2sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; }

say "Fo2sh YouTube Downloader - Setup"
mkdir -p "$DIR/logs" "$HOME/Downloads/YouTube"

# ---- Perl (used by the helper) ----
if [ ! -x /usr/bin/perl ] || ! /usr/bin/perl -MJSON::PP -e1 2>/dev/null; then
  bad "Perl not found on this Mac. Setup can't continue."
  read -r -p "Press Enter to close"; exit 1
fi
ok "Perl"

# ---- yt-dlp ----
# Uses the unpacked macOS build: the single-file build unpacks Python at every run,
# and macOS blocks those files when Chrome starts it ("Python.framework is damaged").
say "1/3  yt-dlp"
install_ytdlp() {
  rm -rf "$TMP/y" && mkdir -p "$TMP/y"
  curl -fL --progress-bar -o "$TMP/y/yt.zip" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip" || return 1
  unzip -oq "$TMP/y/yt.zip" -d "$TMP/y/out" || return 1
  local exe
  exe="$(find "$TMP/y/out" -type f -name 'yt-dlp_macos' | head -1)"
  [ -n "$exe" ] || return 1
  local root
  root="$(dirname "$exe")"
  rm -rf "$DIR/yt-dlp-app" && mv "$root" "$DIR/yt-dlp-app" || return 1
  chmod +x "$DIR/yt-dlp-app/yt-dlp_macos"
  xattr -dr com.apple.quarantine "$DIR/yt-dlp-app" 2>/dev/null
  printf '#!/bin/bash\nexec "%s/yt-dlp-app/yt-dlp_macos" "$@"\n' "$DIR" > "$DIR/yt-dlp"
  chmod +x "$DIR/yt-dlp"
}
if [ -x "$DIR/yt-dlp-app/yt-dlp_macos" ] && [ "$(head -c 2 "$DIR/yt-dlp" 2>/dev/null)" = "#!" ] && "$DIR/yt-dlp" --version >/dev/null 2>&1; then
  echo "  (already installed, skipping download)"
else
  install_ytdlp
fi
if "$DIR/yt-dlp" --version >/dev/null 2>&1; then
  ok "yt-dlp $("$DIR/yt-dlp" --version)"
else
  bad "yt-dlp download failed. Check your internet and run this file again."
  read -r -p "Press Enter to close"; exit 1
fi

# ---- ffmpeg + ffprobe ----
say "2/3  ffmpeg"
ARCH="$(uname -m)"
works() { [ -x "$1" ] && "$1" -version >/dev/null 2>&1; }

get_tool() {  # $1 = ffmpeg | ffprobe
  local name="$1" url
  works "$DIR/$name" && { ok "$name already installed"; return 0; }
  for p in /opt/homebrew/bin /usr/local/bin; do
    if works "$p/$name"; then ln -sf "$p/$name" "$DIR/$name"; ok "$name (from $p)"; return 0; fi
  done
  local urls=()
  if [ "$ARCH" = "arm64" ]; then
    urls+=("https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/$name.zip")
  else
    urls+=("https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/$name.zip")
  fi
  urls+=("https://evermeet.cx/ffmpeg/getrelease/$name/zip" "https://evermeet.cx/ffmpeg/get/$name/zip")
  for url in "${urls[@]}"; do
    rm -rf "$TMP/x" && mkdir -p "$TMP/x"
    if curl -fsL -o "$TMP/x/a.zip" "$url" && unzip -oq "$TMP/x/a.zip" -d "$TMP/x" 2>/dev/null; then
      local bin
      bin="$(find "$TMP/x" -type f -name "$name" | head -1)"
      if [ -n "$bin" ]; then
        chmod +x "$bin"; xattr -d com.apple.quarantine "$bin" 2>/dev/null
        if works "$bin"; then mv "$bin" "$DIR/$name"; ok "$name"; return 0; fi
      fi
    fi
  done
  bad "Could not download $name automatically."
  return 1
}
FF_OK=1
get_tool ffmpeg || FF_OK=0
get_tool ffprobe || true
if [ "$FF_OK" = 0 ]; then
  echo "  Without ffmpeg, only low qualities (360p) and original-format audio will work."
  echo "  Fix: download ffmpeg for macOS, put the 'ffmpeg' file in:"
  echo "       $DIR"
  echo "  then run this setup again."
fi

# ---- Helper + browser connection ----
say "3/3  Connecting to your browsers"
cp "$HERE/host/fo2sh_ytdl_host.pl" "$DIR/fo2sh_ytdl_host.pl"
chmod +x "$DIR/fo2sh_ytdl_host.pl"
xattr -d com.apple.quarantine "$DIR/fo2sh_ytdl_host.pl" 2>/dev/null

MANIFEST="{
  \"name\": \"$HOST_NAME\",
  \"description\": \"Fo2sh YouTube Downloader helper\",
  \"path\": \"$DIR/fo2sh_ytdl_host.pl\",
  \"type\": \"stdio\",
  \"allowed_origins\": [\"chrome-extension://$EXT_ID/\"]
}"

AS="$HOME/Library/Application Support"
for b in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" "Microsoft Edge" "BraveSoftware/Brave-Browser" "Arc/User Data" "Vivaldi" "com.operasoftware.Opera"; do
  if [ -d "$AS/$b" ] || [ "$b" = "Google/Chrome" ]; then
    mkdir -p "$AS/$b/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$AS/$b/NativeMessagingHosts/$HOST_NAME.json"
    ok "${b%%/*}"
  fi
done

xattr -dr com.apple.quarantine "$DIR" 2>/dev/null

say "Done. Now load the 'extension' folder in your browser (Load unpacked), then reload YouTube."
read -r -p "Press Enter to close"
