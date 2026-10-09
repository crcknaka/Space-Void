#!/bin/bash
# usage: shot.sh <url> <out.png> [width=1280] [height=720] [virtual_ms=12000]
# Headless Chrome screenshot with real WebGL. Each call uses a throwaway profile, so calls can run in parallel.
URL="$1"; OUT="$2"; W="${3:-1280}"; H="${4:-720}"; VT="${5:-12000}"
PROF=$(mktemp -d "${TMPDIR:-/tmp}/svshot.XXXXXX")
rm -f "$OUT"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --use-angle=metal --hide-scrollbars \
  --window-size=$W,$H --virtual-time-budget=$VT --user-data-dir="$PROF" --no-first-run --disable-extensions \
  --screenshot="$OUT" "$URL" >/dev/null 2>&1 &
PID=$!
for i in $(seq 1 90); do
  if [ -s "$OUT" ]; then sleep 0.5; break; fi
  sleep 0.5
done
kill $PID 2>/dev/null; sleep 0.2; kill -9 $PID 2>/dev/null
rm -rf "$PROF"
[ -s "$OUT" ] && echo "ok $OUT" || { echo "FAILED (no screenshot)"; exit 1; }
