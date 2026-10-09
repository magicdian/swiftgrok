<div align="center">

# swiftgrok

**Read OpenGrok's largest files at native speed.**

A drop-in reverse proxy that gives [OpenGrok](https://oracle.github.io/opengrok/) a fast, virtualized code viewer — without touching OpenGrok itself.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24%2B-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Docker-lightgrey)](#quick-start)
[![OpenGrok](https://img.shields.io/badge/OpenGrok-1.5%2B--1.13%2B-4c9c45)](#compatibility)

[English](README.md) · 简体中文

</div>

---

Opening a 10k-line file on OpenGrok means the browser parses, lays out and paints **megabytes of pre-rendered HTML** — hundreds of thousands of DOM nodes that freeze any browser. This has been [reported upstream since 2020](https://github.com/oracle/opengrok/issues/3032) and is still unresolved, because the fix requires reworking OpenGrok's jQuery-era web UI.

**swiftgrok fixes it from the outside.** It is a small reverse proxy that sits in front of your OpenGrok instances. Everything passes through byte-for-byte; file pages are rendered by a built-in lazy-loading viewer — swiftgrok replaces OpenGrok's renderer while keeping its search, history and everything else:

| File | Before (DOM payload) | After |
| --- | --- | --- |
| `ConnectivityService.java` (10,978 lines) | 4.0 MB | **7.4 KB** |
| `ActivityManagerService.java` (17,697 lines) | 6.9 MB | **6.9 KB** |

The line markup shown in the viewer **is OpenGrok's own** — syntax colors, symbol links and themes come from OpenGrok itself, so there is no second renderer to maintain and no feature drift.

## Features

- **Virtual scrolling** — only the visible window (± 30 lines) is in the DOM; first paint is a few KB
- **In-file search** — `⌘F` / `Ctrl+F` is taken over (native find only sees rendered lines); matches are highlighted by splicing marks back into OpenGrok's markup, tag- and entity-aware
- **Cross-page selection & copy** — the selection lives in model space (the same idea CodeMirror-based viewers use), so you can drag-select far beyond the rendered window and `⌘C` copies the complete text
- **Multi-source portal** — all your OpenGrok instances on one port with a picker page and per-source health dots
- **Auth passthrough** — HTTP Basic / form sessions are forwarded verbatim; you log in on the proxy origin exactly once
- **Fail-open** — pages that don't match the expected structure are passed through untouched; an OpenGrok upgrade can degrade the experience, never break it
- **Single binary, zero dependencies** — pure Go standard library; the frontend is embedded (no Node toolchain)

## Quick start

```bash
make build
cp config.example.json config.json   # point it at your OpenGrok
./swiftgrok -config config.json
```

Open `http://127.0.0.1:8081/`, pick a source, browse. When swiftgrok is not running, keep using OpenGrok directly — the two never interfere.

### Docker

```bash
docker compose up -d --build
```

## Configuration

```json
{
  "listen": "127.0.0.1:8081",
  "sources": [
    { "name": "local", "upstream": "http://127.0.0.1:8080", "context": "/source" },
    { "name": "android13", "upstream": "http://opengrok.example.com", "context": "/android13" }
  ]
}
```

| Field | Description |
| --- | --- |
| `listen` | Single entry point: the portal plus every source. Use `0.0.0.0:8081` in Docker |
| `name` | Label shown on the portal and in the viewer toolbar |
| `repo` | Optional repository label shown on the portal card |
| `upstream` | OpenGrok base URL (`scheme://host[:port]`) |
| `context` | Webapp context path (`/source`, `/android13`, …). Must be unique — sources are multiplexed on one listener by context path, which is why no link rewriting is ever needed. `/` is reserved for the portal |
| `thresholdLines` | Fall back to OpenGrok's native rendering for pages below this line count. `0` (default, recommended) = swiftgrok renders every file page |

## How it works

OpenGrok's xref pages render **each source line as exactly one HTML line** inside a single `<pre>` — a convention stable across versions since 0.12. swiftgrok:

1. **splits** the page at line boundaries and re-balances tags that span lines (block comments, strings), producing self-contained, independently renderable line HTML;
2. **serves a shell** — OpenGrok's own masthead, search box and scripts — with an empty code area plus a tiny virtual-scroll viewer;
3. **feeds lines** via `GET <context>/swiftgrok/api/lines?p=<path>`, cached against the upstream `ETag`.

```
browser → swiftgrok :8081 ── /            portal (source picker)
                          ├─ /source/**   → OpenGrok A (pass-through)
                          ├─ /android13/** → OpenGrok B (pass-through)
                          └─ large xref   → shell + lines API + viewer
```

## Compatibility

- Tested against OpenGrok **1.5.10 and 1.13.25** (the line convention is far older, and anything unrecognized passes through unchanged)
- Any modern browser benefits — the heavy DOM work happens server-side
- Instances behind HTTP auth (Basic or form login) work through the proxy; the only unsupported case is a cross-domain SSO redirect

## Roadmap

- [ ] Search-result line highlight deep links (`hl` anchors)
- [ ] Code folding (`fold-space`) support
- [ ] Double-click word selection, Shift + arrow keys selection
- [ ] Theme customization (custom CSS injection point)

## Star History

<a href="https://star-history.com/#magicdian/swiftgrok&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=magicdian/swiftgrok&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=magicdian/swiftgrok&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=magicdian/swiftgrok&type=Date" />
 </picture>
</a>
