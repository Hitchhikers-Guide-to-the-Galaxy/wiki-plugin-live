# wiki-plugin-live

Federated Wiki plugin: the farm records a workshop, and the page marks each contribution as it is spoken.

The browser is a remote control. The farm's own machine opens the microphone with ffmpeg and writes one-minute segments, with timestamps that never reset, into the session page's assets folder. The `live` item has Record, Begin, Finish and End (red, set apart), six participant names, a language choice and a Mic Check meter. Every button is a mark stamped on the recorder's clock and written to `marks.json` beside the segments before the answer leaves. End stitches the segments into one m4a for the page.

The recorder is detached from the farm: a farm restart or crash does not stop it, and the next request adopts it again. If ffmpeg itself dies, the segment it was writing is MPEG-TS and readable up to the last packet, so the archive loses at most the minute in progress. Record then says Resume, and a new run starts at the offset where the last run's audio stops.

Phase 1 of the [Live Audio Capture Plan](https://live.private.fish/view/live-audio-capture-plan).

## Item text

```
NAMES: Aycan, Anna Maria, Berk, Deniz, Elif, Selin
LANGUAGES: Turkish, English
MIC: MacBook Air Microphone
Any other line is the caption.
```

## Files

- `assets/<page>/live/seg-RR-NNNN.ts`: segments of run RR
- `assets/<page>/live/segments-RR.csv`: ffmpeg's segment list
- `assets/<page>/live/marks.json`: runs and marks in session seconds (the position in the stitched recording)
- `assets/<page>/<page>.m4a`: the stitched recording, made at End
- `status/live/<page>/`: the recorder's pid, progress, level and log, never served

## Routes

Mounted by [wiki-plugin-farm](https://github.com/Hitchhikers-Guide-to-the-Galaxy/wiki-plugin-farm) from `api/openapi.json` under `/system/api/live/`: `devices`, `status` (reads), and `check`, `record`, `mark`, `end` (writes, gated by the wiki's owner test or an `X-Api-Key` from the site's `status/api-keys.json`).

## Settings

- `LIVE_MIC`: the microphone to use when none is chosen
- `LIVE_SEGMENT_SECONDS`: segment length, 60 by default
- `LIVE_BITRATE`: AAC bitrate, `96k` by default
- `LIVE_FFMPEG`, `LIVE_FFPROBE`: where the tools are, if not in `/opt/homebrew/bin`, `/usr/local/bin` or `/usr/bin`

macOS records through avfoundation and Linux through ALSA (`arecord -L` names).

## Tests

`npm test` runs the unit tests. `test/crash-test.sh <site> <slug> <key-file>` kills and restarts the laptop farm mid-session, so claim the farm with `wiki-wip` first.

## License

MIT
