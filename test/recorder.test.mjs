import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const R = require('../api/recorder.js')
const H = require('../api/handlers.js')

test('avfoundation audio devices are read in order, video devices skipped', () => {
  const text = `[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] Wireless microphone
[AVFoundation indev @ 0x1] [1] MacBook Air Microphone
[in#0 @ 0x2] Error opening input: Input/output error`
  assert.deepEqual(R.parseAvfoundation(text), ['Wireless microphone', 'MacBook Air Microphone'])
})

test('arecord -L names are the unindented lines, null dropped', () => {
  assert.deepEqual(R.parseArecord('null\n    Discard all samples\ndefault\n    Default ALSA\nhw:CARD=Device,DEV=0\n    USB'), ['default', 'hw:CARD=Device,DEV=0'])
})

test('the default microphone is the built-in one unless LIVE_MIC names another', () => {
  assert.equal(R.defaultDevice(['Wireless microphone', 'MacBook Air Microphone']), 'MacBook Air Microphone')
  assert.equal(R.defaultDevice(['USB Mic']), 'USB Mic')
})

test('the record command segments by the minute and never resets timestamps', () => {
  const args = R.recordArgs({ device: 'Mic', run: 2, liveDir: '/x/assets/s/live' })
  const at = flag => args[args.indexOf(flag) + 1]
  assert.equal(at('-segment_time'), String(R.SEGMENT_SECONDS))
  assert.equal(at('-reset_timestamps'), '0')
  assert.equal(at('-segment_format'), 'mpegts')
  assert.ok(args.includes('/x/assets/s/live/seg-02-%04d.ts'))
  assert.equal(at('-progress'), 'progress-02.txt')
})

test('slugs that could climb out of assets are refused', () => {
  assert.throws(() => R.places('/s/status', '../etc'), /not a page slug/)
  assert.throws(() => R.places('/s/status', 'a/b'), /not a page slug/)
  assert.equal(R.places('/s/status', 'session-12').final, '/s/assets/session-12/session-12.m4a')
})

test('marks.json is replaced whole: the old file or the new, never half', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'))
  const file = path.join(dir, 'marks.json')
  R.writeDurably(file, '{"a":1}\n')
  R.writeDurably(file, '{"a":2}\n')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}\n')
  assert.deepEqual(fs.readdirSync(dir), ['marks.json'])
})

test('the open contribution is the last Begin with no Finish', () => {
  const marks = { marks: [
    { kind: 'begin', contribution: 'c1' }, { kind: 'finish', contribution: 'c1' }, { kind: 'begin', contribution: 'c2', speaker: 'Aycan' },
  ] }
  assert.equal(H.openContribution(marks).speaker, 'Aycan')
  marks.marks.push({ kind: 'finish', contribution: 'c2' })
  assert.equal(H.openContribution(marks), null)
})

test('the run clock is out_time plus the age of the progress block, and stops at the end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'))
  const p = { stateDir: dir }
  const file = path.join(dir, 'progress-01.txt')
  fs.writeFileSync(file, 'out_time_us=1000000\nprogress=continue\nout_time_us=8000000\nprogress=continue\n')
  const mtime = fs.statSync(file).mtimeMs
  assert.equal(Math.round(R.runClock(p, 1, mtime + 400) * 10) / 10, 8.4)
  fs.writeFileSync(file, 'out_time_us=8000000\nprogress=end\n')
  assert.equal(R.runClock(p, 1, Date.now() + 5000), 8)
})
