/* swiftgrok viewer — virtual-scroll renderer for OpenGrok xref pages.
 *
 * The server delivers the page shell (OpenGrok chrome included) with an empty
 * code area. This module fetches the per-line HTML via the swiftgrok API and
 * renders only the visible window of lines, recycling DOM nodes on scroll.
 * Line markup is OpenGrok's own, so syntax colors and symbol links are
 * preserved without any re-implementation.
 *
 * In-file search (⌘F / Ctrl+F) runs over the full plain-text line index —
 * the browser's native find only sees the rendered window — and re-injects
 * <mark> highlights into OpenGrok's line markup, entity- and tag-aware.
 */
import { createApp, nextTick, reactive, ref, watch } from './vendor/vue.esm-browser.prod.js'

const mount = document.getElementById('sg-mount')
const scroller = document.getElementById('sg-vscroll')
const sizer = document.getElementById('sg-sizer')
const viewport = document.getElementById('sg-viewport')
const toolbarEl = document.getElementById('sg-toolbar')
const data = JSON.parse(document.getElementById('sg-data').textContent)

const MESSAGES = {
  en: {
    home: 'Back to swiftgrok portal',
    loading: 'swiftgrok loading…',
    loadFailed: 'swiftgrok: failed to load lines, please refresh',
    find: 'Find in file',
    findShort: 'Find in file (⌘F / Ctrl+F)',
    jump: 'Go to line',
    lineNo: 'Line number',
    noResults: 'No results',
    prevMatch: 'Previous match (Shift+Enter)',
    nextMatch: 'Next match (Enter)',
    closeFind: 'Close (Esc)',
    settings: 'Display settings',
    fontSize: 'Font size',
    lineHeight: 'Line height',
    reset: 'Reset defaults',
    decFontSize: 'Decrease font size',
    incFontSize: 'Increase font size',
    decLineHeight: 'Decrease line height',
    incLineHeight: 'Increase line height',
    language: 'Language',
  },
  zh: {
    home: '返回 swiftgrok 主页',
    loading: 'swiftgrok 加载中…',
    loadFailed: 'swiftgrok: 行数据加载失败，请刷新重试',
    find: '在文件中查找',
    findShort: '在文件中查找 (⌘F / Ctrl+F)',
    jump: '跳转到行号',
    lineNo: '行号',
    noResults: '无结果',
    prevMatch: '上一个 (Shift+Enter)',
    nextMatch: '下一个 (Enter)',
    closeFind: '关闭 (Esc)',
    settings: '显示设置',
    fontSize: '字号',
    lineHeight: '行高',
    reset: '恢复默认',
    decFontSize: '减小字号',
    incFontSize: '增大字号',
    decLineHeight: '减小行高',
    incLineHeight: '增大行高',
    language: '语言',
  },
}

// UI locale: localStorage override first, then browser language.
const LOCALE = localStorage.getItem('sg-locale') ||
  ((navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en')
const t = (key) => (MESSAGES[LOCALE] && MESSAGES[LOCALE][key]) || MESSAGES.en[key] || key
document.documentElement.style.setProperty('--sg-loading-text', JSON.stringify(t('loading')))
document.documentElement.style.setProperty('--sg-error-text', JSON.stringify(t('loadFailed')))

const DEFAULTS = { fontSize: 13, lineHeight: 1.5 }
const BUFFER = 30 // extra lines rendered above/below the viewport

const store = reactive({
  state: 'loading', // loading | ready | error
  count: data.count,
  current: 1,
  jump: '',
  showSettings: false,
  settings: loadSettings(),
  search: { open: false, q: '', count: 0, current: -1 },
})

let lines = []
let plainLines = [] // tag-stripped, entity-decoded text per line (search index)
let lowerLines = []
let lh = 20 // rendered line height in px (integer, keeps scroll math exact)
let charW = 7.2
let maxChars = 80
let first = -1
let last = -1

// in-file search state
let matches = [] // [{line, start, end}] plain-text offsets
let matchesByLine = new Map() // line -> [{start, end, cls}]
let matchedLineSet = new Set()
let highlightCache = new Map() // line -> highlighted HTML for current query
let searchTimer = 0
const findInput = ref(null)

// model-space selection state (source-text coords, 0-based {line, col});
// native DOM selection cannot span virtualized pages, so selection lives in
// the model — the same approach CodeMirror-based viewers (cs.android.com)
// use — and is re-rendered as marks for visible lines only.
let selAnchor = null
let selHead = null
let dragging = false
let autoScrollDir = 0
let lastPointer = null

function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('sg-settings') || '{}'))
  } catch {
    return Object.assign({}, DEFAULTS)
  }
}

function saveSettings() {
  localStorage.setItem('sg-settings', JSON.stringify(store.settings))
}

function setState(s) {
  store.state = s
  mount.dataset.state = s
}

/* ---------- metrics ---------- */

function measure() {
  lh = Math.max(1, Math.round(store.settings.fontSize * store.settings.lineHeight))
  const root = document.documentElement
  root.style.setProperty('--sg-font-size', store.settings.fontSize + 'px')
  root.style.setProperty('--sg-lh', lh + 'px')
  const probe = document.createElement('span')
  probe.className = 'sg-line'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.textContent = '0'.repeat(100)
  viewport.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  charW = rect.width / 100 || 7.2
}

function layout() {
  sizer.style.height = lines.length * lh + 'px'
  sizer.style.minWidth = Math.ceil(maxChars * charW + 10 * charW) + 'px'
  // Keep the code area clear of OpenGrok's fixed header. The header's CSS
  // height (e.g. 70px via #content margin) is not reliable across versions,
  // window sizes and logged-in layouts, so measure the real painted bottom
  // of the fixed header (children can overflow its box) and offset the mount.
  mount.style.marginTop = '0px'
  const headerBottom = paintedHeaderBottom()
  if (headerBottom > 0) {
    const mountTop = mount.getBoundingClientRect().top
    if (headerBottom + 8 > mountTop) {
      mount.style.marginTop = Math.ceil(headerBottom + 8 - mountTop) + 'px'
    }
  }
  const top = mount.getBoundingClientRect().top + window.scrollY
  // Reserve the footer so the document never outgrows the viewport: a
  // scrollable window would let the code area slide under the fixed header.
  const footer = document.querySelector('#footer') || document.querySelector('footer')
  const reserve = footer ? footer.getBoundingClientRect().height + 24 : 16
  const h = Math.max(240, window.innerHeight - top - reserve)
  scroller.style.height = h + 'px'
  placeToolbar()
}

// Painted bottom (viewport coords) of the fixed page header, if any.
function paintedHeaderBottom() {
  const header = document.querySelector('#whole_header')
  if (!header) return 0
  const pos = getComputedStyle(header).position
  if (pos !== 'fixed' && pos !== 'sticky') return 0
  let bottom = header.getBoundingClientRect().bottom
  header.querySelectorAll('*').forEach((el) => {
    const b = el.getBoundingClientRect()
    if (b.height > 0 && b.bottom > bottom) bottom = b.bottom
  })
  return bottom
}

// The toolbar is viewport-fixed; keep it aligned with the code area top and
// never over the header, even when the page scrolls or the header resizes.
function placeToolbar() {
  const minTop = paintedHeaderBottom() + 8
  const t = Math.max(mount.getBoundingClientRect().top + 8, minTop, 8)
  toolbarEl.style.top = Math.ceil(t) + 'px'
}

/* ---------- rendering ---------- */

function render(force) {
  if (store.state !== 'ready') return
  const st = scroller.scrollTop
  const h = scroller.clientHeight
  const f = Math.max(0, Math.floor(st / lh) - BUFFER)
  const l = Math.min(lines.length, Math.ceil((st + h) / lh) + BUFFER)
  if (f === first && l === last && !force) return
  first = f
  last = l
  viewport.style.transform = 'translateY(' + f * lh + 'px)'
  let html = ''
  for (let i = f; i < l; i++) {
    // getHighlight returns the raw line when nothing applies (search match,
    // selection) — a single path keeps search and selection marks in sync.
    html += '<div class="sg-line" data-n="' + (i + 1) + '">' + getHighlight(i) + '</div>'
  }
  viewport.innerHTML = html
  store.current = Math.max(1, Math.min(lines.length, Math.floor(st / lh) + 1))
}

let ticking = false
scroller.addEventListener('scroll', () => {
  if (!ticking) {
    ticking = true
    requestAnimationFrame(() => {
      ticking = false
      render()
    })
  }
})

window.addEventListener('resize', () => {
  layout()
  first = last = -1
  render(true)
})

window.addEventListener('scroll', placeToolbar, { passive: true })
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    layout()
    first = last = -1
    render()
  })
}
window.addEventListener('load', () => {
  layout()
  first = last = -1
  render()
})

/* ---------- navigation ---------- */

function goTo(n) {
  n = Math.max(1, Math.min(lines.length, n | 0))
  scroller.scrollTop = Math.max(0, (n - 1) * lh - scroller.clientHeight / 3)
  render()
  const el = viewport.querySelector('.sg-line[data-n="' + n + '"]')
  if (el) {
    el.classList.add('sg-target')
    setTimeout(() => el.classList.remove('sg-target'), 1800)
  }
}

// Line-number anchors: keep the URL hash in sync without a full navigation.
viewport.addEventListener('click', (e) => {
  const a = e.target.closest('a.l')
  if (!a) return
  e.preventDefault()
  const n = parseInt(a.getAttribute('name'), 10)
  if (n > 0) {
    history.replaceState(null, '', '#' + n)
    goTo(n)
  }
})

window.addEventListener('hashchange', () => {
  const n = parseInt(location.hash.slice(1), 10)
  if (n > 0) goTo(n)
})

/* ---------- width estimate ---------- */

// Approximate rendered text length: strip tags, collapse entities to one char.
function textLen(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);|&#[0-9a-fA-F]+;|&[a-zA-Z][a-zA-Z0-9]*;/g, 'x')
    .length
}

/* ---------- in-file search ---------- */

const TAG_SPLIT = /(<[^>]+>)/
const ENTITY_RE = /&#(\d+);|&#x([0-9a-fA-F]+);|&([a-zA-Z][a-zA-Z0-9]*);/g
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

// Decode HTML entities, returning the decoded text plus, per decoded char,
// its raw offset in the input (entities map to their first raw char). The
// char-level map is what lets <mark> highlights be spliced back into the
// original markup at the right places.
function decodeWithMap(s) {
  let out = ''
  const map = []
  let last = 0
  ENTITY_RE.lastIndex = 0
  let m
  while ((m = ENTITY_RE.exec(s))) {
    for (let k = last; k < m.index; k++) {
      out += s[k]
      map.push(k)
    }
    let ch
    if (m[1] !== undefined) ch = String.fromCodePoint(parseInt(m[1], 10))
    else if (m[2] !== undefined) ch = String.fromCodePoint(parseInt(m[2], 16))
    else if (NAMED_ENTITIES[m[3]] !== undefined) ch = NAMED_ENTITIES[m[3]]
    else ch = m[0] // unknown entity: keep raw
    for (const c of ch) {
      out += c
      map.push(m.index)
    }
    last = m.index + m[0].length
  }
  for (let k = last; k < s.length; k++) {
    out += s[k]
    map.push(k)
  }
  return { text: out, map }
}

// Full-line plain text index: native find only sees the rendered window, so
// search runs over this instead.
function buildPlainText() {
  plainLines = lines.map((l) => {
    let t = ''
    for (const part of l.split(TAG_SPLIT)) {
      if (part && !part.startsWith('<')) t += part
    }
    return decodeWithMap(t).text
  })
  lowerLines = plainLines.map((t) => t.toLowerCase())
}

function findMatches(q) {
  const ql = q.toLowerCase()
  const out = []
  for (let i = 0; i < lowerLines.length; i++) {
    const t = lowerLines[i]
    let p = t.indexOf(ql)
    while (p !== -1) {
      out.push({ line: i, start: p, end: p + ql.length })
      p = t.indexOf(ql, p + ql.length) // non-overlapping, keeps marks flat
    }
  }
  return out
}

// Re-splice <mark class="sg-m"> around the current query's matches within
// line i's original markup. Matches may span tags and entities: marks open
// and close at raw offsets mapped from the plain-text match range.
function highlightedLineHTML(i, ranges) {
  const parts = lines[i].split(TAG_SPLIT)
  const segs = []
  let off = 0
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]
    if (!part) continue
    if (part.startsWith('<')) {
      segs.push({ isTag: true, text: part })
    } else {
      const { text, map } = decodeWithMap(part)
      segs.push({ isTag: false, text: part, dec: text, map, plainStart: off })
      off += text.length
    }
  }
  const plan = new Map()
  // Insertions at one raw position must apply open before close (the last
  // applied lands first in the string), so closes sort below opens: key =
  // pos*2 + (open ? 1 : 0), applied in descending key order.
  const add = (si, pos, isOpen, cls) => {
    if (!plan.has(si)) plan.set(si, [])
    const str = isOpen ? '<mark class="' + cls + '">' : '</mark>'
    plan.get(si).push({ key: pos * 2 + (isOpen ? 1 : 0), pos, str })
  }
  // Each overlapped text segment gets its own complete <mark>…</mark> pair:
  // a mark must never cross a closing tag (</b>, </a>, …) or the HTML parser
  // would truncate it. Adjacent segments render as one contiguous highlight.
  for (const r of ranges) {
    for (let k = 0; k < segs.length; k++) {
      const sg = segs[k]
      if (sg.isTag) continue
      const s0 = sg.plainStart
      const s1 = s0 + sg.dec.length
      if (s1 <= r.start) continue
      if (s0 >= r.end) break
      const localS = Math.max(0, r.start - s0)
      const localE = Math.min(sg.dec.length, r.end - s0)
      add(k, sg.map[localS], true, r.cls)
      add(k, localE < sg.dec.length ? sg.map[localE] : sg.text.length, false, r.cls)
    }
  }
  let out = ''
  for (let k = 0; k < segs.length; k++) {
    const sg = segs[k]
    if (sg.isTag) {
      out += sg.text
      continue
    }
    let t = sg.text
    const list = plan.get(k)
    if (list) {
      list.sort((a, b) => b.key - a.key)
      for (const ins of list) t = t.slice(0, ins.pos) + ins.str + t.slice(ins.pos)
    }
    out += t
  }
  return out
}

function getHighlight(i) {
  let h = highlightCache.get(i)
  if (h === undefined) {
    const ranges = (matchesByLine.get(i) || []).map((r) => ({ ...r, cls: 'sg-m' }))
    const sel = selRangesByLine().get(i)
    if (sel) ranges.push(...sel)
    h = ranges.length ? highlightedLineHTML(i, ranges) : lines[i]
    highlightCache.set(i, h)
  }
  return h
}

/* ---------- model-space selection (cross-page copy) ---------- */

// Line-number gutter: "<a class=l>N</a> + fold-space nbsp" prefix length in
// the decoded plain text of each line.
function gutterLen(line1based) {
  return String(line1based).length + 1
}

function srcLen(line0based) {
  return plainLines[line0based].length - gutterLen(line0based + 1)
}

// Normalized selection {s, e} with s <= e, or null.
function selNorm() {
  if (!selAnchor || !selHead) return null
  const cmp = selAnchor.line - selHead.line || selAnchor.col - selHead.col
  return cmp <= 0 ? { s: selAnchor, e: selHead } : { s: selHead, e: selAnchor }
}

// Selection ranges per rendered line, in full-plain coordinates.
function selRangesByLine() {
  const out = new Map()
  const sel = selNorm()
  if (!sel) return out
  for (let ln = sel.s.line; ln <= sel.e.line; ln++) {
    const g = gutterLen(ln + 1)
    const start = ln === sel.s.line ? g + sel.s.col : g
    const end = ln === sel.e.line ? g + sel.e.col : plainLines[ln].length
    if (end > start) out.set(ln, [{ start, end, cls: 'sg-sel' }])
  }
  return out
}

function clearSelection() {
  if (!selAnchor && !selHead) return
  selAnchor = selHead = null
  highlightCache = new Map()
  render(true)
}

// Map a pointer event to a model position {line, col} in source coords.
function posFromEvent(e) {
  const rect = scroller.getBoundingClientRect()
  let line = Math.floor((e.clientY - rect.top + scroller.scrollTop) / lh)
  line = Math.max(0, Math.min(lines.length - 1, line))
  const lineEl = viewport.querySelector('.sg-line[data-n="' + (line + 1) + '"]')
  const relX = lineEl ? e.clientX - lineEl.getBoundingClientRect().left : 0
  let col = Math.round(relX / charW) - gutterLen(line + 1)
  return { line, col: Math.max(0, Math.min(srcLen(line), col)) }
}

function extractSelection() {
  const sel = selNorm()
  if (!sel) return null
  const parts = []
  for (let ln = sel.s.line; ln <= sel.e.line; ln++) {
    const src = plainLines[ln].slice(gutterLen(ln + 1))
    if (sel.s.line === sel.e.line) parts.push(src.slice(sel.s.col, sel.e.col))
    else if (ln === sel.s.line) parts.push(src.slice(sel.s.col))
    else if (ln === sel.e.line) parts.push(src.slice(0, sel.e.col))
    else parts.push(src)
  }
  return parts.join('\n')
}

viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || store.state !== 'ready') return
  if (e.target.closest('a')) return // line-number / symbol links keep working
  // Take over the whole drag gesture: without this the browser starts its
  // own native selection as soon as the pointer leaves the code area (over
  // the selectable header/footer), painting blue over the page.
  e.preventDefault()
  window.getSelection().removeAllRanges()
  dragging = true
  selAnchor = selHead = posFromEvent(e)
  highlightCache = new Map()
  render(true)
})

// While a model drag is active no native selection may start anywhere —
// the pointer routinely crosses the header and footer mid-drag.
document.addEventListener('selectstart', (e) => {
  if (dragging) e.preventDefault()
})

window.addEventListener('pointermove', (e) => {
  if (!dragging) return
  lastPointer = e
  selHead = posFromEvent(e)
  highlightCache = new Map()
  render(true)
  const rect = scroller.getBoundingClientRect()
  autoScrollDir = e.clientY < rect.top + 24 ? -1 : e.clientY > rect.bottom - 24 ? 1 : 0
})

window.addEventListener('pointerup', () => {
  dragging = false
  autoScrollDir = 0
})

// Drag past the edges keeps extending the selection into not-yet-rendered
// lines — the model selection makes that just work.
function autoScrollLoop() {
  if (dragging && autoScrollDir && lastPointer) {
    scroller.scrollTop += autoScrollDir * 18
    selHead = posFromEvent(lastPointer)
    highlightCache = new Map()
    render(true)
  }
  requestAnimationFrame(autoScrollLoop)
}
requestAnimationFrame(autoScrollLoop)

// Serve Cmd+C from the model selection; native copy still handles inputs.
document.addEventListener('copy', (e) => {
  if (window.getSelection().toString()) return
  const text = extractSelection()
  if (text === null) return
  e.preventDefault()
  e.clipboardData.setData('text/plain', text)
})

function runSearch() {
  const q = store.search.q
  highlightCache = new Map()
  matchesByLine = new Map()
  if (!q) {
    matches = []
    matchedLineSet = new Set()
    store.search.count = 0
    store.search.current = -1
    first = last = -1
    render()
    return
  }
  matches = findMatches(q)
  for (let idx = 0; idx < matches.length; idx++) {
    const m = matches[idx]
    matchedLineSet.add(m.line)
    if (!matchesByLine.has(m.line)) matchesByLine.set(m.line, [])
    matchesByLine.get(m.line).push(m)
  }
  store.search.count = matches.length
  store.search.current = matches.length ? 0 : -1
  first = last = -1
  render()
  if (matches.length) goToMatch(0)
}

function goToMatch(idx) {
  const m = matches[idx]
  if (!m) return
  goTo(m.line + 1)
}

function stepMatch(delta) {
  if (!matches.length) return
  store.search.current = (store.search.current + delta + matches.length) % matches.length
  goToMatch(store.search.current)
}

function openFind() {
  store.search.open = true
  const sel = (window.getSelection().toString() || '').trim()
  if (sel && sel.length <= 200) store.search.q = sel
  nextTick(() => {
    const el = findInput.value
    if (el) {
      el.focus()
      el.select()
    }
  })
}

function closeFind() {
  store.search.open = false
}

function toggleFind() {
  store.search.open ? closeFind() : openFind()
}

// Take over the native find: it cannot see beyond the rendered window.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
    if (store.state !== 'ready') return
    e.preventDefault()
    openFind()
  }
  if (e.key === 'Escape' && !store.search.open) clearSelection()
})

watch(
  () => store.search.q,
  () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(runSearch, 120)
  },
)

/* ---------- settings ---------- */

function applySettings() {
  saveSettings()
  measure()
  if (store.state === 'ready') {
    layout()
    first = last = -1
    render()
  }
}

/* ---------- init ---------- */

async function init() {
  try {
    const res = await fetch(data.api + '?p=' + encodeURIComponent(data.p))
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const payload = await res.json()
    lines = payload.lines
    store.count = lines.length
    measure()
    for (const l of lines) {
      const t = textLen(l)
      if (t > maxChars) maxChars = t
    }
    setState('ready')
    layout()
    buildPlainText()
    render()
    const n = parseInt(location.hash.slice(1), 10)
    if (n > 0) goTo(n)
  } catch (err) {
    console.error('swiftgrok:', err)
    setState('error')
  }
}

/* ---------- toolbar (Vue) ---------- */

createApp({
  setup() {
    const doJump = () => {
      const n = parseInt(store.jump, 10)
      if (n > 0) {
        goTo(n)
        store.jump = ''
      }
    }
    const bump = (key, delta, min, max) => {
      const v = Math.round((store.settings[key] + delta) * 10) / 10
      store.settings[key] = Math.max(min, Math.min(max, v))
      applySettings()
    }
    const reset = () => {
      store.settings = Object.assign({}, DEFAULTS)
      applySettings()
    }
    const setLocale = (l) => {
      localStorage.setItem('sg-locale', l)
      location.reload()
    }
    return { store, doJump, bump, reset, toggleFind, stepMatch, closeFind, findInput, t, locale: LOCALE, setLocale }
  },
  template: `
  <div class="sgt">
    <div class="sgt-bar" role="toolbar" aria-label="swiftgrok">
      <a class="sgt-home" href="/" :title="t('home')" :aria-label="t('home')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </a>
      <span class="sgt-brand" :title="'swiftgrok · ' + ($props.source || '')">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        swiftgrok
      </span>
      <span class="sgt-pos" v-if="store.state === 'ready'">L {{ store.current }} / {{ store.count }}</span>
      <span class="sgt-pos sgt-dim" v-else-if="store.state === 'loading'">加载中…</span>
      <button v-if="store.state === 'ready'" class="sgt-gear" :class="{ on: store.search.open }"
              @click="toggleFind" :title="t('findShort')" :aria-label="t('find')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </button>
      <form class="sgt-jump" @submit.prevent="doJump" v-if="store.state === 'ready'">
        <input v-model="store.jump" type="text" inputmode="numeric" :placeholder="t('lineNo')"
               :aria-label="t('jump')" autocomplete="off" spellcheck="false" />
        <button type="submit" :title="t('jump')" :aria-label="t('jump')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </form>
      <button class="sgt-gear" :class="{ on: store.showSettings }" @click="store.showSettings = !store.showSettings"
              :title="t('settings')" :aria-label="t('settings')" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>
        </svg>
      </button>
    </div>
    <transition name="sgt-slide">
      <div class="sgt-find" v-if="store.search.open">
        <input ref="findInput" v-model="store.search.q" type="text" :placeholder="t('find')"
               :aria-label="t('find')" autocomplete="off" spellcheck="false"
               @keydown.enter.prevent="stepMatch($event.shiftKey ? -1 : 1)"
               @keydown.esc.stop.prevent="closeFind" />
        <span class="sgt-count" :class="{ dim: !store.search.q || !store.search.count }">
          {{ store.search.q ? (store.search.count ? (store.search.current + 1) + ' / ' + store.search.count : t('noResults')) : '' }}
        </span>
        <button type="button" @click="stepMatch(-1)" :disabled="!store.search.count" :title="t('prevMatch')" :aria-label="t('prevMatch')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button type="button" @click="stepMatch(1)" :disabled="!store.search.count" :title="t('nextMatch')" :aria-label="t('nextMatch')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button type="button" @click="closeFind" :title="t('closeFind')" :aria-label="t('closeFind')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    </transition>
    <transition name="sgt-slide">
      <div class="sgt-panel" v-if="store.showSettings">
        <div class="sgt-row">
          <span>{{ t('fontSize') }}</span>
          <div class="sgt-step">
            <button @click="bump('fontSize', -1, 11, 20)" :aria-label="t('decFontSize')">−</button>
            <b>{{ store.settings.fontSize }}px</b>
            <button @click="bump('fontSize', 1, 11, 20)" :aria-label="t('incFontSize')">+</button>
          </div>
        </div>
        <div class="sgt-row">
          <span>{{ t('lineHeight') }}</span>
          <div class="sgt-step">
            <button @click="bump('lineHeight', -0.1, 1.2, 2.2)" :aria-label="t('decLineHeight')">−</button>
            <b>{{ store.settings.lineHeight }}</b>
            <button @click="bump('lineHeight', 0.1, 1.2, 2.2)" :aria-label="t('incLineHeight')">+</button>
          </div>
        </div>
        <div class="sgt-row">
          <span>{{ t('language') }}</span>
          <div class="sgt-lang">
            <button :class="{ on: locale === 'en' }" @click="setLocale('en')">EN</button>
            <button :class="{ on: locale === 'zh' }" @click="setLocale('zh')">中文</button>
          </div>
        </div>
        <div class="sgt-row">
          <button class="sgt-reset" @click="reset">{{ t('reset') }}</button>
        </div>
      </div>
    </transition>
  </div>`,
}).mount(document.getElementById('sg-toolbar'))

init()

// debug handle for troubleshooting (harmless in production)
window.__sg = {
  get state() {
    return { selAnchor, selHead, first, last, lh, dragging }
  },
  selRangesByLine,
  getHighlight,
}
