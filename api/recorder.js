// recorder.js — the farm owns the microphone. CommonJS (see api/package.json).
//
// One ffmpeg per session, spawned detached so it outlives the farm: a restart
// of the wiki (another session's wiki-start --restart, a crash) does not stop
// the recording, and the next request adopts the process again from the pid it
// left on disk. If ffmpeg itself dies, the segments it finished are whole and
// the one it was writing is MPEG-TS flushed packet by packet, readable up to
// the last one — so the archive loses at most the minute in progress, and in
// practice a fraction of a second.
//
// Where things are, for a session page <slug> on a site:
//
//   assets/<slug>/live/seg-RR-NNNN.ts   one-minute segments of run RR, timestamps never reset
//   assets/<slug>/live/segments-RR.csv  ffmpeg's own list: file, start, end
//   assets/<slug>/live/marks.json       runs and marks, rewritten (fsync) on every mark
//   assets/<slug>/<slug>.m4a            the stitched recording, made at End
//   status/live/<slug>/                 recorder.json (pid), progress, levels, ffmpeg log —
//                                       the running state, never served
//
// The clock. Every mark is stamped in SESSION seconds: the position in the
// stitched recording. Within a run that is ffmpeg's own output clock (the
// progress file's out_time, extrapolated from the file's mtime to now), plus
// the run's offset — the summed length of the runs before it, which exist only
// when a recording was interrupted and resumed.

const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')

const SEGMENT_SECONDS = Number(process.env.LIVE_SEGMENT_SECONDS) || 60
const BITRATE = process.env.LIVE_BITRATE || '96k'
const LEVEL_WINDOW = 9600 // samples at 48 kHz: one peak reading every 0.2 s

const problem = (status, message) => Object.assign(new Error(message), { status })

// ---------- ffmpeg ----------

/** ffmpeg and ffprobe, wherever they are: a farm started by launchd has a short PATH. */
const tool = name => {
  const env = process.env[`LIVE_${name.toUpperCase()}`]
  if (env) return env
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return name
}

const run = (cmd, args, opts = {}) =>
  new Promise(resolve => {
    execFile(cmd, args, { timeout: opts.timeout || 60 * 1000, maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd }, (error, stdout, stderr) =>
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }),
    )
  })

// ---------- microphones ----------

/** The audio devices ffmpeg's avfoundation input reports, in its order. */
const parseAvfoundation = text => {
  const out = []
  let audio = false
  for (const line of String(text).split('\n')) {
    if (/AVFoundation audio devices/.test(line)) audio = true
    else if (/AVFoundation video devices/.test(line)) audio = false
    else if (audio) {
      const m = line.match(/\]\s*\[(\d+)\]\s*(.+?)\s*$/)
      if (m) out.push(m[2])
    }
  }
  return out
}

/** ALSA capture names from `arecord -L`: the unindented lines. */
const parseArecord = text =>
  String(text)
    .split('\n')
    .filter(l => l && !/^\s/.test(l) && l !== 'null')

let deviceCache = { at: 0, list: [] }
const devices = async () => {
  if (Date.now() - deviceCache.at < 30 * 1000 && deviceCache.list.length) return deviceCache.list
  let list = []
  if (process.platform === 'darwin') {
    const r = await run(tool('ffmpeg'), ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 15000 })
    list = parseAvfoundation(r.stderr)
  } else if (process.platform === 'linux') {
    const r = await run('arecord', ['-L'], { timeout: 15000 })
    list = parseArecord(r.stdout)
    if (!list.includes('default')) list.unshift('default')
  }
  deviceCache = { at: Date.now(), list }
  return list
}

/** The device the farm records from when nobody chooses: LIVE_MIC, a built-in microphone, else the first. */
const defaultDevice = list =>
  (process.env.LIVE_MIC && list.includes(process.env.LIVE_MIC) && process.env.LIVE_MIC) ||
  list.find(d => /built-?in|macbook.*microphone/i.test(d)) ||
  (list.includes('default') ? 'default' : list[0] || '')

const inputArgs = device => {
  if (process.platform === 'darwin') return ['-f', 'avfoundation', '-i', `:${device}`]
  if (process.platform === 'linux') return ['-f', 'alsa', '-i', device || 'default']
  throw problem(501, `this farm runs on ${process.platform}, where the recorder does not know how to open a microphone`)
}

// The meter: a branch of the same audio, a peak reading every 0.2 s printed to
// levels.txt (relative: ffmpeg runs in the state directory, so no path has to
// survive filter-graph quoting).
const METER = `asetnsamples=n=${LEVEL_WINDOW}:p=0,astats=metadata=1:reset=1:measure_overall=Peak_level:measure_perchannel=none,ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=levels.txt:direct=1`
const PREP = 'aresample=48000,aformat=channel_layouts=mono'

const recordArgs = ({ device, run: r, liveDir }) => {
  const rr = String(r).padStart(2, '0')
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    ...inputArgs(device),
    '-filter_complex', `[0:a]${PREP},asplit=2[rec][m];[m]${METER},anullsink`,
    '-map', '[rec]', '-c:a', 'aac', '-b:a', BITRATE,
    '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-reset_timestamps', '0',
    '-segment_format', 'mpegts',
    // Without this the open segment stays 0 bytes until ffmpeg closes it (its
    // write buffer is large), and a kill -9 loses the whole minute. Measured
    // 2026-10-15: 20.4 s lost at a crash 20 s into a segment, ~0.2 s with it.
    '-segment_format_options', 'flush_packets=1',
    '-segment_list', path.join(liveDir, `segments-${rr}.csv`), '-segment_list_type', 'csv',
    path.join(liveDir, `seg-${rr}-%04d.ts`),
    '-progress', `progress-${rr}.txt`, '-stats_period', '0.5',
  ]
}

// The state dir rides along as metadata so `ps` can tell this check from any other ffmpeg.
const checkArgs = ({ device, seconds, stateDir }) => [
  '-hide_banner', '-nostdin', '-loglevel', 'warning',
  ...inputArgs(device),
  '-t', String(seconds),
  '-af', `${PREP},${METER}`,
  '-metadata', `comment=live-check:${stateDir}`,
  '-f', 'null', '-',
]

// ---------- places ----------

const checkSlug = slug => {
  const s = String(slug ?? '')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) throw problem(400, `not a page slug: ${slug}`)
  return s
}

const places = (status, slug) => {
  if (!status) throw problem(500, 'the farm did not say where this site lives')
  const s = checkSlug(slug)
  const site = path.dirname(status)
  const assetsDir = path.join(site, 'assets', s)
  return {
    slug: s,
    assetsDir,
    liveDir: path.join(assetsDir, 'live'),
    stateDir: path.join(status, 'live', s),
    final: path.join(assetsDir, `${s}.m4a`),
  }
}

// ---------- files that must survive a crash ----------

/** Write, flush to disk, then rename into place: a crash leaves the old file or the new, never half of one. */
const writeDurably = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    const dfd = fs.openSync(path.dirname(file), 'r')
    fs.fsyncSync(dfd)
    fs.closeSync(dfd)
  } catch {}
}

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const newMarks = slug => ({
  session: slug,
  clock: 'seconds from the start of the stitched recording',
  created: new Date().toISOString(),
  segmentSeconds: SEGMENT_SECONDS,
  runs: [],
  marks: [],
  ended: null,
  recording: null,
})

const readMarks = p => readJson(path.join(p.liveDir, 'marks.json'))
const writeMarks = (p, marks) => writeDurably(path.join(p.liveDir, 'marks.json'), JSON.stringify(marks, null, 1) + '\n')

// ---------- the running process ----------

const alive = pid => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** Whether pid is still OUR ffmpeg — a pid can be reused once its process is gone. */
const isOurs = async (pid, marker) => {
  if (!alive(pid)) return false
  const r = await run('ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 5000 })
  return /ffmpeg/.test(r.stdout) && r.stdout.includes(marker)
}

/** What is running for this session: { kind: 'record'|'check', pid, run, device } or null. */
const running = async p => {
  const rec = readJson(path.join(p.stateDir, 'recorder.json'))
  if (!rec || !rec.pid) return null
  const marker = rec.kind === 'record' ? p.liveDir : `live-check:${p.stateDir}`
  return (await isOurs(rec.pid, marker)) ? rec : null
}

const startFfmpeg = (p, kind, args, about) => {
  fs.mkdirSync(p.stateDir, { recursive: true })
  if (kind === 'record') fs.mkdirSync(p.liveDir, { recursive: true })
  fs.rmSync(path.join(p.stateDir, 'levels.txt'), { force: true })
  const log = fs.openSync(path.join(p.stateDir, kind === 'record' ? `ffmpeg-${String(about.run).padStart(2, '0')}.log` : 'ffmpeg-check.log'), 'a')
  const child = spawn(tool('ffmpeg'), args, { cwd: p.stateDir, detached: true, stdio: ['ignore', log, log] })
  fs.closeSync(log)
  child.on('error', () => {})
  child.unref()
  const rec = { kind, pid: child.pid, started: new Date().toISOString(), ...about }
  writeDurably(path.join(p.stateDir, 'recorder.json'), JSON.stringify(rec, null, 1) + '\n')
  return rec
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Ask ffmpeg to finish (it closes the segment it is writing), and wait; kill it if it will not. */
const stop = async pid => {
  if (!alive(pid)) return
  try {
    process.kill(pid, 'SIGINT')
  } catch {}
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(250)
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100)
  }
}

const logTail = (p, name) => {
  try {
    return fs
      .readFileSync(path.join(p.stateDir, name), 'utf8')
      .split('\n')
      .filter(l => l.trim() && !/NSCameraUseContinuityCameraDeviceType|frame size not set|Last message repeated/.test(l))
      .slice(-3)
      .join(' ')
  } catch {
    return ''
  }
}

// ---------- reading the recorder's clock and level ----------

const tail = (file, bytes) => {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const { size, mtimeMs } = fs.fstatSync(fd)
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    return { text: buf.toString('utf8'), mtimeMs, size }
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * Seconds of audio ffmpeg has written in this run, now: the last out_time in
 * its progress file, plus the time since that block was written (the file's
 * mtime) — unless the block says the run has ended.
 */
const runClock = (p, r, now = Date.now(), { extrapolate = true } = {}) => {
  const t = tail(path.join(p.stateDir, `progress-${String(r).padStart(2, '0')}.txt`), 2048)
  if (!t) return null
  const outs = [...t.text.matchAll(/out_time_us=(\d+)/g)]
  if (!outs.length) return null
  const out = Number(outs[outs.length - 1][1]) / 1e6
  const ended = /progress=end\s*$/.test(t.text)
  return ended || !extrapolate ? out : out + Math.max(0, now - t.mtimeMs) / 1000
}

/** The last few peak readings, oldest first, and how old the newest is. */
const levels = p => {
  const t = tail(path.join(p.stateDir, 'levels.txt'), 4096)
  if (!t) return { peaks: [], age: null }
  const peaks = [...t.text.matchAll(/Peak_level=(-?[\d.]+|-inf)/g)].map(m => (m[1] === '-inf' ? -120 : Math.round(Number(m[1]) * 10) / 10))
  return { peaks: peaks.slice(-30), age: Math.round((Date.now() - t.mtimeMs) / 100) / 10 }
}

// ---------- segments and stitching ----------

const segmentsOf = (p, r) => {
  const prefix = r ? `seg-${String(r).padStart(2, '0')}-` : 'seg-'
  try {
    return fs
      .readdirSync(p.liveDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.ts'))
      .sort()
  } catch {
    return []
  }
}

const probeDuration = async file => {
  const r = await run(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 60000 })
  const d = parseFloat(r.stdout)
  return Number.isFinite(d) ? Math.round(d * 1000) / 1000 : null
}

/**
 * One run's segments as one m4a, by the concat protocol: MPEG-TS is made to be
 * joined end to end, and with timestamps never reset the result keeps ffmpeg's
 * clock exactly — so a mark's run seconds are the position in this file.
 */
const stitchRun = async (p, r) => {
  const segs = segmentsOf(p, r)
  if (!segs.length) return { file: null, duration: 0 }
  const name = `run-${String(r).padStart(2, '0')}.m4a`
  const out = path.join(p.liveDir, name)
  const res = await run(
    tool('ffmpeg'),
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', `concat:${segs.join('|')}`, '-c', 'copy', '-movflags', '+faststart', name],
    { cwd: p.liveDir, timeout: 10 * 60 * 1000 },
  )
  if (res.error) throw problem(500, `stitching run ${r} failed: ${res.stderr.trim().split('\n').slice(-2).join(' ')}`)
  return { file: out, duration: await probeDuration(out) }
}

/** Every run, in order, as <slug>.m4a; each run placed at the offset its marks were stamped with. */
const stitchAll = async (p, marks) => {
  const files = []
  for (const r of marks.runs) {
    const { file, duration } = await stitchRun(p, r.run)
    if (!file) continue
    if (r.duration == null) r.duration = duration
    files.push({ file, duration: r.duration })
  }
  if (!files.length) throw problem(409, 'there are no segments to stitch')
  const tmp = `${p.final}.part.m4a`
  if (files.length === 1) {
    fs.copyFileSync(files[0].file, tmp)
  } else {
    const list = path.join(p.liveDir, 'runs.txt')
    fs.writeFileSync(list, files.map(f => `file '${path.basename(f.file)}'\nduration ${f.duration}\n`).join(''))
    const res = await run(
      tool('ffmpeg'),
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'runs.txt', '-c', 'copy', '-movflags', '+faststart', tmp],
      { cwd: p.liveDir, timeout: 10 * 60 * 1000 },
    )
    fs.rmSync(list, { force: true })
    if (res.error) throw problem(500, `joining the runs failed: ${res.stderr.trim().split('\n').slice(-2).join(' ')}`)
  }
  fs.renameSync(tmp, p.final)
  // The run files are derived; the segments are the archive and stay until the page is reviewed.
  for (const f of files) fs.rmSync(f.file, { force: true })
  return { duration: await probeDuration(p.final) }
}

module.exports = {
  SEGMENT_SECONDS,
  problem,
  tool,
  devices,
  defaultDevice,
  parseAvfoundation,
  parseArecord,
  recordArgs,
  checkArgs,
  places,
  checkSlug,
  writeDurably,
  newMarks,
  readMarks,
  writeMarks,
  alive,
  running,
  startFfmpeg,
  stop,
  logTail,
  runClock,
  levels,
  segmentsOf,
  probeDuration,
  stitchRun,
  stitchAll,
  sleep,
}
