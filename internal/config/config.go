// Package config loads swiftgrok source definitions.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Source describes one OpenGrok instance that swiftgrok fronts. Sources are
// multiplexed on the shared listener by their context path, which must be
// unique across sources (e.g. "/source", "/android13").
type Source struct {
	// Name is a short label shown on the portal page and viewer toolbar.
	Name string `json:"name"`
	// Repo is an optional repository label shown on the portal page,
	// e.g. "aosp-android13".
	Repo string `json:"repo"`
	// Upstream is the OpenGrok base URL, e.g. "http://127.0.0.1:8080".
	Upstream string `json:"upstream"`
	// Context is the webapp context path, e.g. "/source" or "/android13".
	Context string `json:"context"`
	// ThresholdLines is the line count above which xref pages get the
	// virtual-scroll viewer; smaller pages pass through untouched.
	ThresholdLines int `json:"thresholdLines"`
}

// Config is the top-level configuration file.
type Config struct {
	// Listen is the single swiftgrok entry point serving the portal and
	// all sources. Use "0.0.0.0:8081" when running in Docker.
	Listen  string   `json:"listen"`
	Sources []Source `json:"sources"`
}

// Load reads a JSON config file and applies defaults and validation.
func Load(path string) (*Config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var cfg Config
	dec := json.NewDecoder(f)
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:8081"
	}
	if len(cfg.Sources) == 0 {
		return nil, fmt.Errorf("%s: no sources configured", path)
	}
	seen := map[string]bool{}
	for i := range cfg.Sources {
		s := &cfg.Sources[i]
		if s.Name == "" || s.Upstream == "" || s.Context == "" {
			return nil, fmt.Errorf("%s: source #%d needs name, upstream and context", path, i)
		}
		s.Context = "/" + strings.Trim(s.Context, "/")
		if s.Context == "/" {
			return nil, fmt.Errorf("%s: source %q: context \"/\" is reserved for the portal", path, s.Name)
		}
		if seen[s.Context] {
			return nil, fmt.Errorf("%s: duplicate context %q (contexts must be unique to share one listener)", path, s.Context)
		}
		seen[s.Context] = true
		if s.ThresholdLines <= 0 {
			s.ThresholdLines = 3000
		}
	}
	return &cfg, nil
}
