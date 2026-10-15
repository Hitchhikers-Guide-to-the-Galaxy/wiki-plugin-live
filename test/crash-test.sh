#!/bin/bash
# crash-test.sh — Phase 1's crash test, on the laptop farm.
#
# Records a session from the real microphone with one-minute segments, marks
# contributions, and crashes things twice:
#
#   1. kill -9 the farm alone. The recorder is detached, so it should go on;
#      the restarted farm adopts it and marks continue on the same clock.
#   2. kill -9 the farm AND ffmpeg together (the laptop's power, near enough).
#      The archive should lose at most the minute in progress — in fact only
#      what MPEG-TS had not flushed — and marks.json nothing.
#
# Then Resume and End, and check the stitched m4a. Prints a report and leaves
# report.json in the session's live folder.
#
#   test/crash-test.sh <site> <slug> <api-key-file>
#   test/crash-test.sh live.localhost session-test ~/live-key
#
# It kills and restarts the PRIVATE laptop farm: claim it with wiki-wip first.

set -euo pipefail
SITE=${1:-live.localhost}
SLUG=${2:-session-test}
KEY=$(cat "${3:?api key file}")
FARM="$HOME/Music/Guides/Private"
LIVE="$FARM/$SITE/assets/$SLUG/live"
API="http://$SITE/system/api/live"

post() { curl -sf -X POST "$API/$1.json" -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' -d "$2"; }
status() { curl -sf "$API/status.json?slug=$SLUG"; }
field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }
say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
killfarm() { pkill -9 -f "wiki/index.js --config $FARM/config.json" || true; }
startfarm() {
  "$HOME/bin/wiki-start" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do curl -sf "$API/devices.json" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "farm did not come back" >&2; exit 1
}

if [ -f "$LIVE/marks.json" ]; then
  mv "$FARM/$SITE/assets/$SLUG" "$FARM/$SITE/assets/$SLUG.before-crash-test.$(date +%s)"
fi

T0=$(date +%s.%N 2>/dev/null || python3 -c 'import time;print(time.time())')
say "Record"; post record "{\"slug\":\"$SLUG\"}" | field 'd["state"], d["device"]'
sleep 10; say "Begin Aycan"; post mark "{\"slug\":\"$SLUG\",\"kind\":\"begin\",\"speaker\":\"Aycan\",\"language\":\"Turkish\"}" | field 'd["marked"][-1]["t"]'
sleep 30; say "Finish";      post mark "{\"slug\":\"$SLUG\",\"kind\":\"finish\"}" | field 'd["marked"][-1]["t"]'
sleep 30; say "Begin Anna Maria"; post mark "{\"slug\":\"$SLUG\",\"kind\":\"begin\",\"speaker\":\"Anna Maria\",\"language\":\"English\"}" | field 'd["marked"][-1]["t"]'
sleep 15

# --- crash 1: the farm alone ---
PID=$(python3 -c "import json;print(json.load(open('$FARM/$SITE/status/live/$SLUG/recorder.json'))['pid'])")
cp "$LIVE/marks.json" /tmp/live-marks-before-1.json
say "CRASH 1: kill -9 the farm (ffmpeg pid $PID)"
killfarm; sleep 3
kill -0 "$PID" 2>/dev/null && say "ffmpeg $PID still running with the farm dead" || say "ffmpeg $PID DIED with the farm"
startfarm
S=$(status); say "farm back: $(echo "$S" | field 'd["state"], d["clock"]')"
cmp -s /tmp/live-marks-before-1.json "$LIVE/marks.json" && say "marks.json unchanged across crash 1" || say "marks.json CHANGED across crash 1"
say "Finish (after crash 1)"; post mark "{\"slug\":\"$SLUG\",\"kind\":\"finish\"}" | field 'd["marked"][-1]["t"]'
sleep 20

# --- crash 2: the farm and ffmpeg together ---
say "Begin Berk"; post mark "{\"slug\":\"$SLUG\",\"kind\":\"begin\",\"speaker\":\"Berk\",\"language\":\"Turkish\"}" | field 'd["marked"][-1]["t"]'
sleep 25
cp "$LIVE/marks.json" /tmp/live-marks-before-2.json
CLOCK2=$(status | field 'd["clock"]')
say "CRASH 2: kill -9 the farm and ffmpeg together at session ${CLOCK2}s"
kill -9 "$PID" 2>/dev/null || true; killfarm; sleep 2
startfarm
S=$(status); say "farm back: $(echo "$S" | field 'd["state"]')"
cmp -s /tmp/live-marks-before-2.json "$LIVE/marks.json" && say "marks.json unchanged across crash 2" || say "marks.json CHANGED across crash 2"
ls -la "$LIVE"

# --- resume and end ---
say "Resume"; post record "{\"slug\":\"$SLUG\"}" | field 'd["state"], d["runs"][-1]["offset"], d["runs"][0]["duration"]'
sleep 8; say "Begin Deniz"; post mark "{\"slug\":\"$SLUG\",\"kind\":\"begin\",\"speaker\":\"Deniz\",\"language\":\"English\"}" | field 'd["marked"][-1]["t"]'
sleep 12; say "End"; post end "{\"slug\":\"$SLUG\"}" | field 'd["state"], d["recording"], d["clock"]'

python3 - "$LIVE" "$CLOCK2" "/tmp/live-marks-before-2.json" <<'EOF'
import json, sys, subprocess, os
live, clock2, before2 = sys.argv[1], float(sys.argv[2]), sys.argv[3]
m = json.load(open(os.path.join(live, 'marks.json')))
b = json.load(open(before2))
final = os.path.join(os.path.dirname(live), m['recording'])
dur = float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',final],capture_output=True,text=True).stdout)
r1 = m['runs'][0]
kept_prefix = m['marks'][:len(b['marks'])] == b['marks']
report = {
  'run1_audio_kept': r1['duration'],
  'run1_clock_at_crash2': clock2,
  'archive_lost_at_crash2_seconds': round(clock2 - r1['duration'], 3),
  'marks_before_crash2': len(b['marks']),
  'marks_kept_identical': kept_prefix,
  'runs': m['runs'],
  'stitched': m['recording'],
  'stitched_duration': dur,
  'runs_total': round(sum(r['duration'] or 0 for r in m['runs']), 3),
  'end_mark': m['marks'][-1],
}
json.dump(report, open(os.path.join(live, 'report.json'), 'w'), indent=1)
print(json.dumps(report, indent=1))
EOF
