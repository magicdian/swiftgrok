/* swiftgrok viewer — virtual-scroll renderer for OpenGrok xref pages.
 *
 * The server delivers the page shell (OpenGrok chrome included) with an empty
 * code area. This module fetches the per-line HTML via the swiftgrok API and
 * renders only the visible window of lines, recycling DOM nodes on scroll.
 * Line markup is OpenGrok's own, so syntax colors and symbol links are
 * preserved without any re-implementation.
 */
import { createApp, reactive } from './vendor/vue.esm-browser.prod.js'

const mount = document.getElementById('sg-mount')
const scroller = document.getElementById('sg-vscroll')
const sizer = document.getElementById('sg-sizer')
const viewport = document.getElementById('sg-viewport')
const toolbarEl = document.getElementById('sg-toolbar')
const data = JSON.parse(document.getElementById('sg-data').textContent)

const DEFAULTS = { fontSize: 13, lineHeight: 1.5 }
const BUFFER = 30 // extra lines rendered above/below the viewport

const store = reactive({
  state: 'loading', // loading | ready | error
  count: data.count,
  current: 1,
  jump: '',
  showSettings: false,
  settings: loadSettings(),
})

let lines = []
let lh = 20 // rendered line height in px (integer, keeps scroll math exact)
let charW = 7.2
let maxChars = 80
let first = -1
let last = -1

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
  const h = Math.max(240, window.innerHeight - top - 16)
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

function render() {
  if (store.state !== 'ready') return
  const st = scroller.scrollTop
  const h = scroller.clientHeight
  const f = Math.max(0, Math.floor(st / lh) - BUFFER)
  const l = Math.min(lines.length, Math.ceil((st + h) / lh) + BUFFER)
  if (f === first && l === last) return
  first = f
  last = l
  viewport.style.transform = 'translateY(' + f * lh + 'px)'
  let html = ''
  for (let i = f; i < l; i++) {
    html += '<div class="sg-line" data-n="' + (i + 1) + '">' + (lines[i] || '') + '</div>'
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
  render()
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
    return { store, doJump, bump, reset }
  },
  template: `
  <div class="sgt">
    <div class="sgt-bar" role="toolbar" aria-label="swiftgrok">
      <a class="sgt-home" href="/" title="返回 swiftgrok 主页" aria-label="返回 swiftgrok 主页">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </a>
      <span class="sgt-brand" :title="'swiftgrok · ' + ($props.source || '')">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        swiftgrok
      </span>
      <span class="sgt-pos" v-if="store.state === 'ready'">L {{ store.current }} / {{ store.count }}</span>
      <span class="sgt-pos sgt-dim" v-else-if="store.state === 'loading'">加载中…</span>
      <form class="sgt-jump" @submit.prevent="doJump" v-if="store.state === 'ready'">
        <input v-model="store.jump" type="text" inputmode="numeric" placeholder="行号"
               aria-label="跳转到行号" autocomplete="off" spellcheck="false" />
        <button type="submit" title="跳转" aria-label="跳转到行号">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </form>
      <button class="sgt-gear" :class="{ on: store.showSettings }" @click="store.showSettings = !store.showSettings"
              title="显示设置" aria-label="显示设置" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>
        </svg>
      </button>
    </div>
    <transition name="sgt-slide">
      <div class="sgt-panel" v-if="store.showSettings">
        <div class="sgt-row">
          <span>字号</span>
          <div class="sgt-step">
            <button @click="bump('fontSize', -1, 11, 20)" aria-label="减小字号">−</button>
            <b>{{ store.settings.fontSize }}px</b>
            <button @click="bump('fontSize', 1, 11, 20)" aria-label="增大字号">+</button>
          </div>
        </div>
        <div class="sgt-row">
          <span>行高</span>
          <div class="sgt-step">
            <button @click="bump('lineHeight', -0.1, 1.2, 2.2)" aria-label="减小行高">−</button>
            <b>{{ store.settings.lineHeight }}</b>
            <button @click="bump('lineHeight', 0.1, 1.2, 2.2)" aria-label="增大行高">+</button>
          </div>
        </div>
        <div class="sgt-row">
          <button class="sgt-reset" @click="reset">恢复默认</button>
        </div>
      </div>
    </transition>
  </div>`,
}).mount(document.getElementById('sg-toolbar'))

init()
