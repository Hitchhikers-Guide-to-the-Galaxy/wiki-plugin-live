// handlers.js — the Live plugin's operations, mounted by the Farm plugin.
//
// Like the Voice Tool, live has no server of its own: these operations are
// declared in package.json (fedwiki.api), mounted beneath /system/api/live/,
// and the writing ones are gated by the wiki's own owner test.
//
//   devices  — the microphones the farm's machine can record from
//   status   — what the session's recorder is doing: state, clock, level, marks
//   check    — Mic Check: open the microphone for a while and feed the meter only
//   record   — start the recorder (or resume it after an interruption)
//   mark     — Begin or Finish a contribution, stamped on the recorder's clock
//   end      — the End mark, stop the recorder, stitch the segments into one m4a
//
// Every mark is on disk (marks.json, fsync'd) before the answer leaves, so a
// crash after a button press loses nothing the button said.

const fs = require('node:fs')
const path = require('node:path')
const R = require('./recorder.js')

const { problem } = R

// One operation at a time per session: two phones pressing Begin together must
// not both read marks.json and each write a different one.
const locks = new Map()
const serial = (key, fn) => {
  const prev = locks.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(key, next.catch(() => {}))
  return next
}

const round = s => Math.round(s * 1000) / 1000

const clean = (value, max, what) => {
  const v = String(value ?? '').trim()
  if (v.length > max) throw problem(400, `${what} is too long`)
  return v
}

/** The contribution open now: the last Begin with no Finish. */
const openContribution = marks => {
  const finished = new Set(marks.marks.filter(m => m.kind === 'finish').map(m => m.contribution))
  const begun = marks.marks.filter(m => m.kind === 'begin' && !finished.has(m.contribution))
  return begun[begun.length - 1] || null
}

const currentRun = marks => {
  const last = marks.runs[marks.runs.length - 1]
  return last && !last.ended ? last : null
}

const sessionSeconds = (p, marks, run) => {
  const rt = R.runClock(p, run.run)
  return round(run.offset + (rt == null ? 0 : rt))
}

const pushMark = (marks, mark) => {
  const m = { n: marks.marks.length + 1, ...mark, wall: new Date().toISOString() }
  marks.marks.push(m)
  return m
}

/**
 * Close a run whose ffmpeg is gone without an End — a crash, a pulled cable, a
 * killed process. Its length is what its segments hold, measured by stitching
 * them, so the next run starts exactly where this one's audio stops.
 */
const closeInterrupted = async (p, marks) => {
  const run = currentRun(marks)
  if (!run) return null
  const { duration } = await R.stitchRun(p, run.run)
  fs.rmSync(path.join(p.liveDir, `run-${String(run.run).padStart(2, '0')}.m4a`), { force: true })
  const segs = R.segmentsOf(p, run.run)
  let last = Date.now()
  if (segs.length) last = fs.statSync(path.join(p.liveDir, segs[segs.length - 1])).mtimeMs
  Object.assign(run, { ended: new Date(last).toISOString(), how: 'interrupted', duration })
  return run
}

const stateOf = async (p, marks) => {
  const proc = await R.running(p)
  if (proc && proc.kind === 'record') return { state: 'recording', proc }
  if (marks && currentRun(marks)) return { state: 'interrupted', proc }
  if (proc && proc.kind === 'check') return { state: marks && marks.ended ? 'ended' : 'checking', proc, checking: true }
  if (marks && marks.ended) return { state: 'ended', proc }
  if (marks && marks.runs.length) return { state: 'stopped', proc }
  return { state: 'idle', proc }
}

// ---------- operations ----------

const devices = async () => {
  const list = await R.devices()
  return { platform: process.platform, devices: list, default: R.defaultDevice(list) }
}

const status = async ({ slug, status: statusDir }) => {
  const p = R.places(statusDir, slug)
  const marks = R.readMarks(p)
  const { state, proc, checking } = await stateOf(p, marks)
  const run = marks && currentRun(marks)
  const segs = R.segmentsOf(p)
  let bytes = 0
  for (const f of segs) {
    try {
      bytes += fs.statSync(path.join(p.liveDir, f)).size
    } catch {}
  }
  let clock = null
  if (state === 'recording' && run) clock = sessionSeconds(p, marks, run)
  else if (state === 'interrupted' && run) {
    // Where ffmpeg last said it was; the segments hold about this much.
    const rt = R.runClock(p, run.run, Date.now(), { extrapolate: false })
    clock = rt == null ? run.offset : round(run.offset + rt)
  } else if (marks && marks.runs.length) {
    const last = marks.runs[marks.runs.length - 1]
    clock = last.duration != null ? round(last.offset + last.duration) : null
  }
  return {
    slug: p.slug,
    state,
    checking: !!checking || (proc && proc.kind === 'check') || false,
    device: (proc && proc.device) || (run && run.device) || (marks && marks.device) || null,
    clock,
    run: run ? run.run : null,
    runs: marks ? marks.runs : [],
    marks: marks ? marks.marks : [],
    open: marks ? openContribution(marks) : null,
    segments: segs.length,
    bytes,
    segmentSeconds: R.SEGMENT_SECONDS,
    level: proc ? R.levels(p) : { peaks: [], age: null },
    recording: fs.existsSync(p.final) ? `assets/${p.slug}/${p.slug}.m4a` : null,
    marksFile: marks ? `assets/${p.slug}/live/marks.json` : null,
    ended: marks ? marks.ended : null,
    problem:
      state === 'interrupted'
        ? `the recorder stopped without an End${(l => (l ? ` — ffmpeg said: ${l}` : ', and left no reason (killed, or the machine stopped)'))(R.logTail(p, `ffmpeg-${String(run.run).padStart(2, '0')}.log`))}. Record resumes; the segments so far are kept.`
        : null,
  }
}

const chooseDevice = async device => {
  const list = await R.devices()
  const d = String(device || '').trim() || R.defaultDevice(list)
  if (!d) throw problem(503, 'this farm can see no microphone')
  if (!list.includes(d)) throw problem(400, `no microphone called "${d}" here — choose one of: ${list.join(', ')}`)
  return d
}

const check = ({ slug, device, seconds, stop, status: statusDir }) => {
  const p = R.places(statusDir, slug)
  return serial(p.liveDir, async () => {
    const proc = await R.running(p)
    if (proc && proc.kind === 'record') return status({ slug, status: statusDir }) // the meter is already live
    if (proc && proc.kind === 'check') await R.stop(proc.pid)
    if (!stop) {
      const d = await chooseDevice(device)
      const s = Math.max(3, Math.min(Number(seconds) || 30, 300))
      R.startFfmpeg(p, 'check', R.checkArgs({ device: d, seconds: s, stateDir: p.stateDir }), { device: d, seconds: s })
      await R.sleep(600)
    }
    return status({ slug, status: statusDir })
  })
}

const record = ({ slug, device, status: statusDir }) => {
  const p = R.places(statusDir, slug)
  return serial(p.liveDir, async () => {
    const proc = await R.running(p)
    if (proc && proc.kind === 'record') throw problem(409, 'the recorder is already running for this page')
    if (proc && proc.kind === 'check') await R.stop(proc.pid)
    const d = await chooseDevice(device)
    const marks = R.readMarks(p) || R.newMarks(p.slug)
    const resumed = await closeInterrupted(p, marks)
    for (const r of marks.runs) if (r.duration == null) r.duration = (await R.stitchRun(p, r.run)).duration
    const offset = round(marks.runs.reduce((sum, r) => sum + (r.duration || 0), 0))
    const n = marks.runs.length + 1
    const run = { run: n, device: d, started: new Date().toISOString(), offset, ended: null, how: null, duration: null }
    // The run and its mark are on disk before ffmpeg starts: a crash in between leaves an
    // interrupted run with no segments, which resumes cleanly.
    // Someone speaking when the recorder died is finished where the audio stops
    // and begun again where it resumes, so no clip spans the missing time.
    const open = resumed ? openContribution(marks) : null
    if (open) pushMark(marks, { kind: 'finish', t: offset, run: resumed.run, contribution: open.contribution, speaker: open.speaker, language: open.language, auto: true, after: 'interrupted' })
    marks.runs.push(run)
    marks.device = d
    marks.ended = null
    pushMark(marks, { kind: n === 1 ? 'record' : 'resume', t: offset, run: n, ...(resumed ? { after: 'interrupted' } : {}) })
    if (open) {
      const count = marks.marks.filter(m => m.kind === 'begin').length
      pushMark(marks, { kind: 'begin', t: offset, run: n, contribution: `c${count + 1}`, speaker: open.speaker, language: open.language, auto: true, continues: open.contribution })
    }
    R.writeMarks(p, marks)
    const rec = R.startFfmpeg(p, 'record', R.recordArgs({ device: d, run: n, liveDir: p.liveDir }), { device: d, run: n })
    // Wait for ffmpeg's first word on its clock; if it dies first, say why.
    for (let i = 0; i < 40; i++) {
      await R.sleep(250)
      if (R.runClock(p, n) != null) break
      if (!R.alive(rec.pid)) {
        throw problem(500, `the recorder stopped at once: ${R.logTail(p, `ffmpeg-${String(n).padStart(2, '0')}.log`) || 'no reason given'}`)
      }
    }
    return status({ slug, status: statusDir })
  })
}

const mark = ({ slug, kind, speaker, language, status: statusDir }) => {
  const p = R.places(statusDir, slug)
  return serial(p.liveDir, async () => {
    const k = String(kind || '').toLowerCase()
    if (!['begin', 'finish'].includes(k)) throw problem(400, 'kind is begin or finish (End has its own operation)')
    const marks = R.readMarks(p)
    const run = marks && currentRun(marks)
    const proc = await R.running(p)
    if (!run || !proc || proc.kind !== 'record') throw problem(409, 'the recorder is not running — press Record first')
    const t = sessionSeconds(p, marks, run)
    const open = openContribution(marks)
    const made = []
    if (k === 'begin') {
      // A Begin while someone is still open closes them at the same instant: the
      // facilitator moved on, and the clip should end where the next one starts.
      if (open) made.push(pushMark(marks, { kind: 'finish', t, run: run.run, contribution: open.contribution, speaker: open.speaker, language: open.language, auto: true }))
      const count = marks.marks.filter(m => m.kind === 'begin').length
      made.push(
        pushMark(marks, {
          kind: 'begin',
          t,
          run: run.run,
          contribution: `c${count + 1}`,
          speaker: clean(speaker, 80, 'the speaker'),
          language: clean(language, 40, 'the language'),
        }),
      )
    } else {
      if (!open) throw problem(409, 'nobody has begun — press Begin first')
      made.push(pushMark(marks, { kind: 'finish', t, run: run.run, contribution: open.contribution, speaker: open.speaker, language: open.language }))
    }
    R.writeMarks(p, marks)
    return { marked: made, ...(await status({ slug, status: statusDir })) }
  })
}

const end = ({ slug, status: statusDir }) => {
  const p = R.places(statusDir, slug)
  return serial(p.liveDir, async () => {
    const marks = R.readMarks(p)
    if (!marks || !marks.runs.length) throw problem(409, 'nothing has been recorded for this page')
    const proc = await R.running(p)
    const run = currentRun(marks)
    if (run && proc && proc.kind === 'record') {
      const t = sessionSeconds(p, marks, run)
      const open = openContribution(marks)
      if (open) pushMark(marks, { kind: 'finish', t, run: run.run, contribution: open.contribution, speaker: open.speaker, language: open.language, auto: true })
      pushMark(marks, { kind: 'end', t, run: run.run })
      R.writeMarks(p, marks) // the End is kept before anything that can fail
      await R.stop(proc.pid)
      Object.assign(run, { ended: new Date().toISOString(), how: 'end', duration: null })
    } else if (run) {
      await closeInterrupted(p, marks)
      const t = round(run.offset + (run.duration || 0))
      const open = openContribution(marks)
      if (open) pushMark(marks, { kind: 'finish', t, run: run.run, contribution: open.contribution, speaker: open.speaker, language: open.language, auto: true })
      pushMark(marks, { kind: 'end', t, run: run.run, after: 'interrupted' })
      R.writeMarks(p, marks)
    }
    // Already ended: End again re-stitches, which is how a failed stitch is retried.
    const { duration } = await R.stitchAll(p, marks)
    marks.ended = marks.ended || new Date().toISOString()
    marks.recording = `${p.slug}.m4a`
    marks.duration = duration
    R.writeMarks(p, marks)
    return status({ slug, status: statusDir })
  })
}

module.exports = { devices, status, check, record, mark, end, openContribution }
