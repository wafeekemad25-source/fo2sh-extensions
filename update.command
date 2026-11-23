#!/bin/bash
# Fo2sh extensions - update everything from GitHub in one go.
# Run it from Terminal:  bash  (space)  then drag this file in, then Enter.
# It puts the latest version of every extension in ~/Documents, then you press Reload in Chrome.

REPO="wafeekemad25-source/fo2sh-extensions"
DEST="$HOME/Documents"
EXTS="fo2sh-pinterest-downloader fo2sh-reddit-downloader fo2sh-instagram-downloader fo2sh-youtube-downloader"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }

ver() {  # version written in a manifest.json, or "-" if missing
  local f="$1/manifest.json"; [ -f "$f" ] || f="$1/extension/manifest.json"
  [ -f "$f" ] && sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$f" | head -1 || echo "-"
}

say "Fo2sh - updating from GitHub"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! curl -fL --progress-bar -o "$TMP/repo.tar.gz" "https://github.com/$REPO/archive/refs/heads/main.tar.gz"; then
  echo "  Could not download. Check the internet and try again."
  read -r -p "Press Enter to close"; exit 1
fi
tar -xzf "$TMP/repo.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name '*-main' | head -1)"

for e in $EXTS; do
  [ -d "$SRC/$e" ] || continue
  OLD="$(ver "$DEST/$e")"
  NEW="$(ver "$SRC/$e")"
  rm -rf "$DEST/$e"
  cp -R "$SRC/$e" "$DEST/$e"
  xattr -dr com.apple.quarantine "$DEST/$e" 2>/dev/null
  if [ "$OLD" = "$NEW" ]; then ok "$e  $NEW (no change)"; else ok "$e  $OLD -> $NEW"; fi
done

# YouTube helper: refresh the helper script if YouTube was set up on this Mac
HELPER="$HOME/Library/Application Support/Fo2sh"
if [ -d "$HELPER" ] && [ -f "$DEST/fo2sh-youtube-downloader/host/fo2sh_ytdl_host.pl" ]; then
  cp "$DEST/fo2sh-youtube-downloader/host/fo2sh_ytdl_host.pl" "$HELPER/fo2sh_ytdl_host.pl"
  chmod +x "$HELPER/fo2sh_ytdl_host.pl"
  ok "YouTube helper updated"
fi

say "Done. Open chrome://extensions and press Reload on each Fo2sh extension."
read -r -p "Press Enter to close"
