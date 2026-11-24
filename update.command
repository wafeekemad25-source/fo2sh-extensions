#!/bin/bash
# Fo2sh extensions - update from GitHub.
# Downloads ONLY the files that changed (compares each file's fingerprint with files.txt on GitHub),
# so a normal update takes seconds. The big ffmpeg file is downloaded once and copied locally.
# Run:  curl -fsSL https://raw.githubusercontent.com/wafeekemad25-source/fo2sh-extensions/main/update.command | bash

REPO="wafeekemad25-source/fo2sh-extensions"
RAW="https://raw.githubusercontent.com/$REPO/main"
DEST="$HOME/Documents"
EXTS="fo2sh-pinterest-downloader fo2sh-reddit-downloader fo2sh-instagram-downloader fo2sh-youtube-downloader"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; }

ver() {
  local f="$1/manifest.json"; [ -f "$f" ] || f="$1/extension/manifest.json"
  if [ -f "$f" ]; then sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$f" | head -1; else echo "-"; fi
}
sha() { shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1; }
urlpath() { printf '%s' "$1" | perl -pe 's/([^A-Za-z0-9\/._~-])/sprintf("%%%02X", ord($1))/ge'; }

say "Fo2sh - checking for updates"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! curl -fsSL "$RAW/files.txt?t=$(date +%s)" -o "$TMP/files.txt"; then
  bad "Could not reach GitHub. Check the internet and try again."; exit 1
fi

# Versions before
for e in $EXTS; do eval "OLD_${e//-/_}=\"$(ver "$DEST/$e")\""; done

TOTAL=$(grep -c . "$TMP/files.txt"); GOT=0; COPIED=0; FAILED=0
HAVE_SHA=(); HAVE_PATH=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  want="${line%%  *}"; path="${line#*  }"
  target="$DEST/$path"
  if [ -f "$target" ] && [ "$(sha "$target")" = "$want" ]; then
    HAVE_SHA+=("$want"); HAVE_PATH+=("$target"); continue
  fi
  mkdir -p "$(dirname "$target")"
  # Same file already on disk (e.g. ffmpeg in another extension)? Copy it instead of downloading.
  src=""
  for i in "${!HAVE_SHA[@]}"; do [ "${HAVE_SHA[$i]}" = "$want" ] && src="${HAVE_PATH[$i]}" && break; done
  if [ -z "$src" ]; then
    for e in $EXTS; do
      cand="$DEST/$e/${path#*/}"
      [ -f "$cand" ] && [ "$cand" != "$target" ] && [ "$(sha "$cand")" = "$want" ] && src="$cand" && break
    done
  fi
  if [ -n "$src" ]; then
    cp "$src" "$target.part" && mv "$target.part" "$target" && COPIED=$((COPIED+1))
  else
    printf "  downloading %s\n" "$path"
    if curl -fL --progress-bar -o "$target.part" "$RAW/$(urlpath "$path")" && [ "$(sha "$target.part")" = "$want" ]; then
      mv "$target.part" "$target"; GOT=$((GOT+1))
    else
      rm -f "$target.part"; bad "failed: $path"; FAILED=$((FAILED+1)); continue
    fi
  fi
  case "$path" in *.command|*.pl) chmod +x "$target";; esac
  HAVE_SHA+=("$want"); HAVE_PATH+=("$target")
done < "$TMP/files.txt"

# Remove files that are no longer part of an extension
for e in $EXTS; do
  [ -d "$DEST/$e" ] || continue
  find "$DEST/$e" -type f ! -name '.DS_Store' | while IFS= read -r f; do
    rel="${f#$DEST/}"
    grep -qF "  $rel" "$TMP/files.txt" || rm -f "$f"
  done
  xattr -dr com.apple.quarantine "$DEST/$e" 2>/dev/null
done

say "Result"
for e in $EXTS; do
  o="OLD_${e//-/_}"; n="$(ver "$DEST/$e")"
  if [ "${!o}" = "$n" ]; then ok "$e  $n (no change)"; else ok "$e  ${!o} -> $n"; fi
done
echo "  ($TOTAL files checked, $GOT downloaded, $COPIED copied locally)"

HELPER="$HOME/Library/Application Support/Fo2sh"
if [ -d "$HELPER" ] && [ -f "$DEST/fo2sh-youtube-downloader/host/fo2sh_ytdl_host.pl" ]; then
  cp "$DEST/fo2sh-youtube-downloader/host/fo2sh_ytdl_host.pl" "$HELPER/fo2sh_ytdl_host.pl"
  chmod +x "$HELPER/fo2sh_ytdl_host.pl"
fi

if [ "$FAILED" -gt 0 ]; then bad "$FAILED file(s) failed. Run the same command again."; exit 1; fi
say "Done. Open chrome://extensions and press Reload on the Fo2sh extensions."
