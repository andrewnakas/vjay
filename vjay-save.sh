#!/usr/bin/env bash
# Save states for VJay. A snapshot you can get back to when an experiment goes
# wrong mid-setup, which is the one time you cannot afford to be debugging.
#
#   ./vjay-save.sh              save now
#   ./vjay-save.sh list         show saves, newest first
#   ./vjay-save.sh restore      restore the newest
#   ./vjay-save.sh restore FILE restore a specific one
set -eu

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
NAME="$(basename "$DIR")"
SAVES="$(dirname "$DIR")/vjay-saves"

save() {
  mkdir -p "$SAVES"
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local out="$SAVES/${NAME}-${stamp}.tgz"
  ( cd "$(dirname "$DIR")" && tar --exclude='.serve.log' --exclude='__pycache__' \
      -czf "$out" "$NAME" )
  echo "saved  $out  ($(du -h "$out" | cut -f1))"
}

list() {
  [ -d "$SAVES" ] || { echo "no saves yet"; return; }
  ls -1t "$SAVES"/*.tgz 2>/dev/null | while read -r f; do
    printf '%s  %s\n' "$(du -h "$f" | cut -f1)" "$(basename "$f")"
  done
}

restore() {
  local f="${1:-}"
  if [ -z "$f" ]; then
    f="$(ls -1t "$SAVES"/*.tgz 2>/dev/null | head -1)"
  elif [ ! -f "$f" ]; then
    f="$SAVES/$f"
  fi
  [ -f "$f" ] || { echo "no such save: ${1:-<newest>}" >&2; exit 1; }
  # Save the current state first. Restoring over unsaved work without a way back
  # is how you lose the thing you were actually trying to keep.
  echo "saving the current state before overwriting it..."
  save
  ( cd "$(dirname "$DIR")" && tar -xzf "$f" )
  echo "restored  $(basename "$f")"
  echo "hard-reload the browser (Ctrl+Shift+R) - Chrome caches the modules."
}

case "${1:-save}" in
  save)    save ;;
  list)    list ;;
  restore) shift; restore "${1:-}" ;;
  *) echo "usage: $0 [save|list|restore [FILE]]" >&2; exit 2 ;;
esac
