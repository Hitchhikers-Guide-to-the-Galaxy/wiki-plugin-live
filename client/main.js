/*
 * Federated Wiki : Live Plugin
 *
 * A remote control for the farm's recorder. The microphone belongs to the farm
 * (see api/recorder.js): this item only asks it to start, to mark, and to end,
 * and shows what it hears. If the browser closes, sleeps or loses the network,
 * the recording goes on.
 *
 * The item's text, in the wiki DSL (UPPERCASE command, optional colon):
 *
 *   NAMES: Aycan, Anna Maria, Berk, Deniz, Elif, Selin
 *   LANGUAGES: Turkish, English
 *   MIC: MacBook Air Microphone
 *   Anything else is the caption.
 *
 * Routes, mounted by the Farm plugin from api/openapi.json:
 *
 *   GET  /system/api/live/devices.json
 *   GET  /system/api/live/status.json?slug=
 *   POST /system/api/live/check.json   { slug, device, stop }
 *   POST /system/api/live/record.json  { slug, device }
 *   POST /system/api/live/mark.json    { slug, kind: begin|finish, speaker, language }
 *   POST /system/api/live/end.json     { slug }
 *
 * Licensed under the MIT license.
 */

const API = '/system/api/live'
const DEFAULT_NAMES = ['Speaker 1', 'Speaker 2', 'Speaker 3', 'Speaker 4', 'Speaker 5', 'Speaker 6']
const DEFAULT_LANGUAGES = ['Turkish', 'English']

const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** NAMES, LANGUAGES and MIC lines; the rest is caption. */
const parse = text => {
  const out = { names: [], languages: [], mic: '', caption: [] }
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Z]+):?\s+(.*)$/)
    const list = v => v.split(',').map(s => s.trim()).filter(Boolean)
    if (m && m[1] === 'NAMES') out.names = list(m[2])
    else if (m && m[1] === 'LANGUAGES') out.languages = list(m[2])
    else if (m && m[1] === 'MIC') out.mic = m[2].trim()
    else if (line.trim()) out.caption.push(line)
  }
  if (!out.names.length) out.names = DEFAULT_NAMES
  if (!out.languages.length) out.languages = DEFAULT_LANGUAGES
  return out
}

/** 754.2 → "12:34.2"; past an hour "1:02:34.2". */
const clock = s => {
  if (s == null || !Number.isFinite(s)) return '–'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(1).padStart(4, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

// The Voice Tool's level zones, so the two meters read alike.
const levelZone = db => {
  if (db > -3) return ['clipping — back off', '#c0392b']
  if (db > -30) return ['good', '#1a7f37']
  if (db > -50) return ['low — speak up or move closer', '#d68910']
  return ['no signal — wrong microphone?', '#c0392b']
}

const STATE_TEXT = {
  idle: 'not recording',
  checking: 'mic check',
  recording: 'recording',
  interrupted: 'interrupted — Record resumes',
  stopped: 'stopped',
  ended: 'ended',
}

const slugOf = $page => ($page.attr('id') || '').split('_rev')[0]

const getJson = async url => {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || body.message || `${res.status} ${res.statusText}`)
  return body
}

const postJson = async (op, body) => {
  const res = await fetch(`${API}/${op}.json`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || out.message || `${res.status} ${res.statusText}`)
  return out
}

const button = (cls, label, style = '') => `<button class="${cls}" style="font-size:.95em; padding:4px 10px; ${style}">${label}</button>`

const html = (item, spec) => `
  <div class="live-box" style="background-color:#eee; padding:12px; border-radius:6px;">
    <div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;">
      <span class="live-dot" style="display:inline-block; width:.8em; height:.8em; border-radius:50%; background:#999;"></span>
      <strong class="live-state">…</strong>
      <span class="live-clock" style="font-family:monospace; font-size:1.5em;">–</span>
      <span class="live-segs" style="font-size:.8em; color:#555;"></span>
    </div>
    <div style="margin:8px 0 6px; display:flex; gap:6px;">
      <select class="live-mic" style="flex:1; min-width:0; font-size:.85em;"></select>
      ${button('live-check', 'Mic Check')}
    </div>
    <canvas class="live-meter" width="400" height="40" style="width:100%; background:#111; border-radius:4px;"></canvas>
    <div style="font-family:monospace; font-size:.8em; height:1.5em; line-height:1.5em; margin:2px 0 6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
      peak <span class="live-db" style="display:inline-block; min-width:3.2em; text-align:right;">–</span> dBFS <span class="live-zone"></span>
    </div>
    <div class="live-names" style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
      ${spec.names.map((n, i) => `<button class="live-name" data-i="${i}" style="font-size:.9em; padding:3px 8px; border:1px solid #889; border-radius:12px; background:white;">${esc(n)}</button>`).join('')}
    </div>
    <div class="live-langs" style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px; font-size:.85em;">
      ${spec.languages.map((l, i) => `<label style="padding:2px 6px;"><input type="radio" name="live-lang-${esc(item.id)}" class="live-lang" value="${esc(l)}"${i === 0 ? ' checked' : ''}> ${esc(l)}</label>`).join('')}
    </div>
    <div style="display:flex; gap:6px; align-items:center;">
      ${button('live-record', 'Record')}
      ${button('live-begin', 'Begin', 'font-weight:bold;')}
      ${button('live-finish', 'Finish', 'font-weight:bold;')}
      <span style="flex:1;"></span>
      ${button('live-end', 'End', 'background:#c0392b; color:white; border:1px solid #922; border-radius:4px; margin-left:24px;')}
    </div>
    <div class="live-open" style="font-size:.9em; margin-top:8px; min-height:1.3em;"></div>
    <ol class="live-marks" style="font-size:.85em; margin:4px 0 0; padding-left:1.6em;"></ol>
    <div class="live-done" style="display:none; margin-top:6px;">
      <audio class="live-player" controls preload="none" style="width:100%;"></audio>
      <div style="font-size:.8em;"><a class="live-marksfile" target="_blank">marks.json</a></div>
    </div>
    <div class="live-msg" style="font-size:.8em; color:#555; margin-top:4px;"></div>
    <div class="live-caption" style="font-size:.85em; color:#555; margin-top:6px;">${esc(spec.caption.join(' ')) || '<i>double-click to set NAMES, LANGUAGES and MIC</i>'}</div>
  </div>`

export const emit = ($item, item) => {
  $item.html(html(item, parse(item.text)))
}

export const bind = ($item, item) => {
  const spec = parse(item.text)
  const el = sel => $item.find(sel)[0]
  const ui = {
    dot: el('.live-dot'), state: el('.live-state'), clock: el('.live-clock'), segs: el('.live-segs'),
    mic: el('.live-mic'), check: el('.live-check'), meter: el('.live-meter'), db: el('.live-db'), zone: el('.live-zone'),
    record: el('.live-record'), begin: el('.live-begin'), finish: el('.live-finish'), end: el('.live-end'),
    open: el('.live-open'), marks: el('.live-marks'), done: el('.live-done'), player: el('.live-player'),
    marksfile: el('.live-marksfile'), msg: el('.live-msg'), caption: el('.live-caption'),
  }
  const $page = $item.parents('.page:first')
  const slug = slugOf($page)
  const site = $page.data('site')
  let speaker = null
  let last = null
  let timer = null
  let busy = false

  $(ui.caption).on('dblclick', () => wiki.textEditor($item, item))

  const say = (text, bad) => {
    ui.msg.textContent = text || ''
    ui.msg.style.color = bad ? '#c0392b' : '#555'
  }

  if (site && site !== location.host && site !== 'origin') {
    say(`This page belongs to ${site}. Open it on its own site to record there.`, true)
    $item.find('button, select, input').prop('disabled', true)
    return
  }

  $item.find('.live-name').each((_, b) => {
    b.onclick = () => {
      speaker = speaker === spec.names[b.dataset.i] ? null : spec.names[b.dataset.i]
      $item.find('.live-name').each((_, x) => {
        const on = spec.names[x.dataset.i] === speaker
        x.style.background = on ? '#1a5fb4' : 'white'
        x.style.color = on ? 'white' : ''
      })
    }
  })
  const language = () => $item.find('.live-lang:checked').val() || ''

  const drawMeter = level => {
    const ctx = ui.meter.getContext('2d')
    const w = ui.meter.width
    const hgt = ui.meter.height
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, w, hgt)
    const peaks = (level && level.peaks) || []
    const fresh = level && level.age != null && level.age < 2
    const n = 30
    const bw = w / n
    peaks.slice(-n).forEach((db, i) => {
      const x = (n - Math.min(peaks.length, n) + i) * bw
      const frac = Math.max(0, Math.min(1, (db + 60) / 60))
      ctx.fillStyle = fresh ? levelZone(db)[1].replace('#1a7f37', '#2ecc71') : '#555'
      ctx.fillRect(x + 1, hgt - frac * hgt, bw - 2, frac * hgt)
    })
    const db = fresh && peaks.length ? peaks[peaks.length - 1] : null
    ui.db.textContent = db == null ? '–' : db <= -90 ? '-inf' : db.toFixed(1)
    if (db == null) {
      ui.zone.textContent = ''
    } else {
      const [text, color] = levelZone(db)
      ui.zone.textContent = text
      ui.zone.style.color = color
    }
  }

  const render = s => {
    last = s
    const recording = s.state === 'recording'
    ui.state.textContent = STATE_TEXT[s.state] || s.state
    ui.dot.style.background = recording ? '#c0392b' : s.state === 'interrupted' ? '#d68910' : s.checking ? '#2ecc71' : '#999'
    ui.clock.textContent = clock(s.clock)
    ui.segs.textContent = s.segments ? `${s.segments} segment${s.segments === 1 ? '' : 's'}, ${(s.bytes / 1e6).toFixed(1)} MB${s.runs.length > 1 ? `, ${s.runs.length} runs` : ''}` : ''
    if (s.device && !recording) ui.mic.value = ui.mic.value || s.device
    if (recording && s.device) ui.mic.value = s.device
    ui.mic.disabled = recording
    ui.check.textContent = s.checking ? 'Stop Check' : 'Mic Check'
    ui.check.disabled = recording
    ui.record.textContent = s.state === 'interrupted' ? 'Resume' : 'Record'
    ui.record.disabled = recording
    ui.begin.disabled = !recording
    ui.finish.disabled = !recording || !s.open
    ui.end.disabled = !(recording || s.state === 'interrupted' || s.state === 'stopped')
    drawMeter(s.level)

    const o = s.open
    ui.open.innerHTML = o
      ? `<span style="color:#c0392b;">●</span> <b>${esc(o.speaker || 'someone')}</b>${o.language ? ` (${esc(o.language)})` : ''} since ${clock(o.t)}`
      : recording
        ? '<span style="color:#777;">nobody marked — choose a name, then Begin</span>'
        : ''
    const begins = s.marks.filter(m => m.kind === 'begin')
    const finishes = new Map(s.marks.filter(m => m.kind === 'finish').map(m => [m.contribution, m]))
    ui.marks.innerHTML = begins
      .slice(-12)
      .map(b => {
        const f = finishes.get(b.contribution)
        return `<li value="${esc(b.contribution.slice(1))}">${esc(b.speaker || '?')}${b.language ? ` <span style="color:#777;">${esc(b.language)}</span>` : ''} — ${clock(b.t)} → ${f ? clock(f.t) : '…'}${f && f.auto ? ' <span style="color:#777;" title="closed by the next Begin or by End">auto</span>' : ''}</li>`
      })
      .join('')

    if (s.recording) {
      ui.done.style.display = ''
      const src = `/${s.recording}?v=${encodeURIComponent(s.ended || '')}`
      if (ui.player.getAttribute('src') !== src) ui.player.setAttribute('src', src)
      ui.marksfile.href = `/${s.marksFile}`
    } else ui.done.style.display = 'none'
    if (s.problem) say(s.problem, true)
    else if (ui.msg.textContent.startsWith('the recorder stopped')) say('')
  }

  const poll = async () => {
    clearTimeout(timer)
    if (!document.body.contains($item[0])) return // the item has left the lineup
    try {
      render(await getJson(`${API}/status.json?slug=${encodeURIComponent(slug)}`))
      if (ui.msg.textContent.startsWith('status: ')) say('') // the farm is back
    } catch (e) {
      say(`status: ${e.message} — the recorder does not depend on this page`, true)
    }
    const active = last && (last.state === 'recording' || last.checking)
    timer = setTimeout(poll, active ? 500 : 4000)
  }

  const act = async (fn, working) => {
    if (busy) return
    busy = true
    if (working) say(working)
    try {
      const s = await fn()
      if (s && s.state) render(s)
      if (working) say('')
    } catch (e) {
      say(e.message, true)
    } finally {
      busy = false
      poll()
    }
  }

  ui.check.onclick = () =>
    act(() => postJson('check', { slug, device: ui.mic.value, stop: !!(last && last.checking) }))
  ui.record.onclick = () => act(() => postJson('record', { slug, device: ui.mic.value }), 'starting the recorder…')
  ui.begin.onclick = () => act(() => postJson('mark', { slug, kind: 'begin', speaker: speaker || '', language: language() }))
  ui.finish.onclick = () => act(() => postJson('mark', { slug, kind: 'finish' }))
  ui.end.onclick = () => {
    if (!confirm('End the session? The recorder stops and the segments are stitched into one recording for this page.')) return
    act(() => postJson('end', { slug }), 'stopping and stitching…')
  }

  getJson(`${API}/devices.json`)
    .then(d => {
      const choice = spec.mic && d.devices.includes(spec.mic) ? spec.mic : d.default
      ui.mic.innerHTML = d.devices.map(n => `<option${n === choice ? ' selected' : ''}>${esc(n)}</option>`).join('')
      if (spec.mic && !d.devices.includes(spec.mic)) say(`MIC ${spec.mic} is not on this farm's machine; using ${d.default}.`, true)
    })
    .catch(e => say(`microphones: ${e.message}`, true))
    .finally(poll)
}

if (typeof window !== 'undefined') {
  window.plugins = window.plugins || {}
  window.plugins.live = { emit, bind }
}

export const live = { parse, clock, levelZone }
