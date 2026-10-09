// Package server fronts OpenGrok instances with a virtual-scroll viewer for
// large xref files. Everything except big xref pages is passed through the
// reverse proxy byte-for-byte; xref pages above the line threshold are
// decomposed and re-served as a shell page plus a lines JSON API.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"html/template"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"swiftgrok/internal/config"
	"swiftgrok/internal/xref"
	"swiftgrok/web"
)

// SourceRuntime is one configured OpenGrok source and its listener state.
type SourceRuntime struct {
	cfg      config.Source
	upstream *url.URL
	client   *http.Client
	cache    *xref.Cache
}

// Server serves the portal and all configured sources on a single listener.
// Sources are multiplexed by their context path, which config validation
// guarantees to be unique — the same shape as multiple OpenGrok webapps
// behind one nginx, so upstream pages need no link rewriting.
type Server struct {
	cfg     *config.Config
	sources []*SourceRuntime
	portal  *template.Template
}

// New validates the config and prepares per-source runtimes.
func New(cfg *config.Config) (*Server, error) {
	portal, err := template.ParseFS(web.FS, "portal.html")
	if err != nil {
		return nil, fmt.Errorf("parse portal template: %w", err)
	}
	s := &Server{cfg: cfg, portal: portal}
	for i := range cfg.Sources {
		sc := cfg.Sources[i]
		u, err := url.Parse(sc.Upstream)
		if err != nil {
			return nil, fmt.Errorf("source %q: bad upstream: %w", sc.Name, err)
		}
		if u.Path == "" || u.Path == "/" {
			u.Path = ""
		}
		sr := &SourceRuntime{
			cfg:      sc,
			upstream: u,
			client:   &http.Client{Timeout: 60 * time.Second},
			// Per-source budget; with many sources this keeps total memory
			// bounded (a 10k-line split is roughly 4MB).
			cache: xref.NewCache(64 << 20),
		}
		s.sources = append(s.sources, sr)
	}
	return s, nil
}

// Run starts the listener and blocks.
func (s *Server) Run() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRoot)
	for _, sr := range s.sources {
		sr := sr
		mux.Handle(sr.cfg.Context+"/", sr.mux())
	}
	for _, sr := range s.sources {
		log.Printf("swiftgrok: source %q: /%s -> %s", sr.cfg.Name, strings.TrimPrefix(sr.cfg.Context, "/"), sr.cfg.Upstream+sr.cfg.Context)
	}
	log.Printf("swiftgrok: portal: http://%s/", s.cfg.Listen)
	return http.ListenAndServe(s.cfg.Listen, mux)
}

// handleRoot serves the source-picker portal at "/" and a 404 page for
// paths that match no source context.
func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>404 · swiftgrok</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;justify-content:center;padding-top:20vh}div{text-align:center}a{color:#16a34a}</style></head>
<body><div><p>404 · 该路径不属于任何已配置的源</p><p><a href="/">&larr; 返回 swiftgrok 主页</a></p></div></body></html>`)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	if err := s.portal.Execute(w, struct{ Sources []config.Source }{Sources: s.cfg.Sources}); err != nil {
		log.Printf("swiftgrok: portal: %v", err)
	}
}

func (sr *SourceRuntime) mux() *http.ServeMux {
	mux := http.NewServeMux()
	base := sr.cfg.Context + "/swiftgrok"
	mux.HandleFunc(base+"/assets/", sr.handleAsset)
	mux.HandleFunc(base+"/api/lines", sr.handleLines)
	proxy := sr.newProxy()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeHTTP(w, r)
	})
	return mux
}

type inboundHostKey struct{}

func (sr *SourceRuntime) newProxy() *httputil.ReverseProxy {
	upstream := sr.upstream
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(upstream)
			// Let the transport own compression so ModifyResponse always
			// sees plain bodies; the browser receives identity encoding.
			pr.Out.Header.Del("Accept-Encoding")
			// Keep the inbound Host around for redirect rewriting.
			ctx := context.WithValue(pr.Out.Context(), inboundHostKey{}, pr.In.Host)
			pr.Out = pr.Out.WithContext(ctx)
		},
		ModifyResponse: sr.transformResponse,
	}
}

// transformResponse rewrites redirect targets that point at the upstream back
// to this proxy (OpenGrok 302s file URLs to absolute ?r=<rev> locations), and
// intercepts large xref file pages, rewriting them into the swiftgrok shell.
// Everything else passes through unchanged.
func (sr *SourceRuntime) transformResponse(res *http.Response) error {
	req := res.Request
	if req == nil {
		return nil
	}
	if loc := res.Header.Get("Location"); loc != "" {
		if inHost, ok := req.Context().Value(inboundHostKey{}).(string); ok && inHost != "" {
			if u, err := url.Parse(loc); err == nil && u.Host == sr.upstream.Host {
				scheme := "http"
				if req.TLS != nil {
					scheme = "https"
				}
				u.Scheme = scheme
				u.Host = inHost
				res.Header.Set("Location", u.String())
			}
		}
	}
	if req.Method != http.MethodGet || res.StatusCode != http.StatusOK {
		return nil
	}
	if !strings.Contains(res.Header.Get("Content-Type"), "text/html") {
		return nil
	}
	if !strings.HasPrefix(req.URL.Path, sr.cfg.Context+"/xref/") || strings.HasSuffix(req.URL.Path, "/") {
		return nil
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		return restoreBody(res, body)
	}
	sp, splitErr := xref.SplitPage(string(body))
	if splitErr != nil || len(sp.Lines) < sr.cfg.ThresholdLines {
		// Fail-open: not a file view, unexpected structure, or small file.
		return restoreBody(res, body)
	}

	// The page has already been fetched and decomposed; keep it for the
	// lines API so the browser does not trigger a second upstream fetch.
	sr.cache.Put(sr.cacheKey(req), &xref.Entry{Split: sp, ETag: res.Header.Get("ETag")})

	page := sr.buildViewerPage(req, sp)
	res.Header.Del("Content-Encoding")
	res.Header.Del("ETag")
	res.Header.Set("Content-Type", "text/html; charset=utf-8")
	res.Header.Set("Cache-Control", "no-cache")
	res.Body = io.NopCloser(strings.NewReader(page))
	res.ContentLength = int64(len(page))
	res.Header.Set("Content-Length", strconv.Itoa(len(page)))
	return nil
}

func restoreBody(res *http.Response, body []byte) error {
	res.Body = io.NopCloser(strings.NewReader(string(body)))
	res.ContentLength = int64(len(body))
	res.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return nil
}

// cacheKey includes the request cookies: cookies can affect xref rendering
// (e.g. search highlighting), so entries must not be shared across cookies.
func (sr *SourceRuntime) cacheKey(req *http.Request) string {
	return req.URL.RequestURI() + "|" + hashStr(req.Header.Get("Cookie"))
}

func hashStr(s string) string {
	h := fnv.New32a()
	h.Write([]byte(s))
	return strconv.FormatUint(uint64(h.Sum32()), 16)
}

type viewerData struct {
	Count  int    `json:"count"`
	API    string `json:"api"`
	Path   string `json:"p"`
	Source string `json:"source"`
}

const viewerMount = `<div id="sg-mount" data-state="loading"><div id="sg-toolbar"></div><div id="sg-vscroll"><div id="sg-sizer"><div id="sg-viewport"></div></div></div></div>`

func (sr *SourceRuntime) buildViewerPage(req *http.Request, sp *xref.Split) string {
	data := viewerData{
		Count:  len(sp.Lines),
		API:    sr.cfg.Context + "/swiftgrok/api/lines",
		Path:   req.URL.RequestURI(),
		Source: sr.cfg.Name,
	}
	payload, _ := json.Marshal(data)

	var b strings.Builder
	b.WriteString(sp.Head)
	b.WriteString(viewerMount)
	b.WriteString(sp.Tail)
	page := b.String()

	inject := `<link rel="stylesheet" href="` + sr.cfg.Context + `/swiftgrok/assets/viewer.css">` +
		`<script id="sg-data" type="application/json">` + string(payload) + `</script>` +
		`<script type="module" src="` + sr.cfg.Context + `/swiftgrok/assets/viewer.js"></script>`
	if i := strings.LastIndex(strings.ToLower(page), "</body>"); i >= 0 {
		page = page[:i] + inject + page[i:]
	} else {
		page += inject
	}
	return page
}

// handleAsset serves the embedded viewer frontend.
func (sr *SourceRuntime) handleAsset(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, sr.cfg.Context+"/swiftgrok/assets/")
	if strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	var ctype string
	switch {
	case strings.HasSuffix(name, ".js"):
		ctype = "text/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		ctype = "text/css; charset=utf-8"
	default:
		http.NotFound(w, r)
		return
	}
	f, err := web.FS.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", "max-age=300")
	io.Copy(w, f)
}

// handleLines returns the decomposed per-line HTML for an xref page.
func (sr *SourceRuntime) handleLines(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("p")
	if !strings.HasPrefix(p, sr.cfg.Context+"/xref/") {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	entry, err := sr.loadEntry(r, p)
	if err != nil {
		log.Printf("swiftgrok: source %q: lines %s: %v", sr.cfg.Name, p, err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=60")
	json.NewEncoder(w).Encode(struct {
		Count int      `json:"count"`
		Lines []string `json:"lines"`
	}{
		Count: len(entry.Split.Lines),
		Lines: entry.Split.Lines,
	})
}

// loadEntry returns a cache entry for p, revalidating a cached entry with a
// conditional upstream request and serving stale data if revalidation fails.
func (sr *SourceRuntime) loadEntry(r *http.Request, p string) (*xref.Entry, error) {
	key := p + "|" + hashStr(r.Header.Get("Cookie"))
	if cached, ok := sr.cache.Get(key); ok {
		fresh, err := sr.refetch(r, p, cached.ETag)
		switch {
		case err == nil:
			sr.cache.Put(key, fresh)
			return fresh, nil
		case err == xref.ErrNotModified:
			return cached, nil
		default:
			// Revalidation failed (upstream hiccup): stale is better than 502.
			return cached, nil
		}
	}
	e, err := sr.refetch(r, p, "")
	if err != nil {
		return nil, err
	}
	sr.cache.Put(key, e)
	return e, nil
}

// refetch fetches p from upstream with the caller's cookies. With a non-empty
// etag the request is conditional; a 304 yields ErrNotModified.
func (sr *SourceRuntime) refetch(r *http.Request, p, etag string) (*xref.Entry, error) {
	u := *sr.upstream
	pu, err := url.Parse(p)
	if err != nil {
		return nil, err
	}
	u.Path = pu.Path
	u.RawQuery = pu.RawQuery
	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	if c := r.Header.Get("Cookie"); c != "" {
		req.Header.Set("Cookie", c)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := sr.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return nil, xref.ErrNotModified
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	sp, err := xref.SplitPage(string(body))
	if err != nil {
		return nil, err
	}
	return &xref.Entry{Split: sp, ETag: resp.Header.Get("ETag")}, nil
}
