#!/bin/bash
# Rebuilds files.txt (sha256 + path of every extension file). Run before every commit.
cd "$(dirname "$0")"
find fo2sh-pinterest-downloader fo2sh-reddit-downloader fo2sh-instagram-downloader fo2sh-youtube-downloader \
  -type f ! -name '.DS_Store' | LC_ALL=C sort | while IFS= read -r f; do
  printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"
done > files.txt
echo "files.txt: $(wc -l < files.txt) files"
