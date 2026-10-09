#!/bin/bash
# usage: svlog.sh <url> [virtual_ms=12000]  → prints the hidden #svlog (timeline + ERR lines); url must include &log
URL="$1"; VT="${2:-12000}"
PROF=$(mktemp -d "${TMPDIR:-/tmp}/svshot.XXXXXX")
OUT=$(mktemp "${TMPDIR:-/tmp}/svdom.XXXXXX")
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --use-angle=metal --window-size=1280,720 --virtual-time-budget=$VT --user-data-dir="$PROF" --no-first-run --disable-extensions --dump-dom "$URL" > "$OUT" 2>/dev/null &
PID=$!
for i in $(seq 1 80); do sleep 0.5; grep -q "</html>" "$OUT" 2>/dev/null && break; done
kill $PID 2>/dev/null; sleep 0.2; kill -9 $PID 2>/dev/null; rm -rf "$PROF"
python3 - "$OUT" <<'PY'
import sys,re,html
d=open(sys.argv[1],errors='ignore').read()
m=re.search(r'<pre id="svlog"[^>]*>(.*?)</pre>',d,re.S)
print(html.unescape(m.group(1)) if m else 'NO SVLOG (page did not finish?) len=%d'%len(d))
PY
rm -f "$OUT"
