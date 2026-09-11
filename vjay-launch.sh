#!/usr/bin/env bash
# Start the VJay server if it is not already up, then open it in Chrome.
#
# Written for a dock icon, which means it has to be safe to press twice: the
# second press must not start a second server or lose the camera and microphone
# permissions already granted to the first window.
#
# Usage: vjay-launch.sh [--test] [--tab] [--port N]
#   --test  synthetic 124 BPM audio, no mic needed
#   --tab   open a normal browser tab instead of a chromeless app window
set -u

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PORT=8080
QUERY=""
APPMODE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --test) QUERY="?test=1" ;;
    --tab)  APPMODE=0 ;;
    --port) shift; PORT="${1:-8080}" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

URL="http://localhost:${PORT}/${QUERY}"

notify() {
  command -v notify-send >/dev/null 2>&1 && notify-send -a VJay "VJay" "$1" || echo "$1"
}

up() { curl -sf -o /dev/null --max-time 1 "http://127.0.0.1:${PORT}/index.html"; }

if ! up; then
  [ -x "$DIR/serve.sh" ] || { notify "serve.sh not found in $DIR"; exit 1; }
  # setsid so the server outlives this script and the launching shell - a dock
  # entry's process group goes away as soon as it returns.
  setsid "$DIR/serve.sh" "$PORT" >"$DIR/.serve.log" 2>&1 < /dev/null &
  for _ in $(seq 1 60); do
    up && break
    sleep 0.25
  done
  if ! up; then
    notify "The server did not come up on port ${PORT}. See .serve.log"
    exit 1
  fi
fi

# The DEFAULT Chrome profile on purpose. A separate --user-data-dir would be
# tidier but would start with no camera or microphone permission for
# localhost, which is the one thing you cannot fix from the stage.
CHROME="$(command -v google-chrome || command -v google-chrome-stable || echo /opt/google/chrome/chrome)"

if [ "$APPMODE" -eq 1 ]; then
  exec "$CHROME" --app="$URL" --new-window
else
  exec "$CHROME" --new-window "$URL"
fi
