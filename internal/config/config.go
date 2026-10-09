// Package config loads swiftgrok source definitions.
package config

import (
	"encoding/json"
	"fmt"
	"os"
)

// Source describes one OpenGrok instance that swiftgrok fronts.
type Source struct {
	// Name is a short label shown in logs and the viewer toolbar.
	Name string `json:"name"`
	// Listen is the local address swiftgrok serves this source on.
	Listen string `json:"listen"`
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
	Sources []Source `json:"sources"`
}

// Load reads a JSON config file and applies defaults.
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
	if len(cfg.Sources) == 0 {
		return nil, fmt.Errorf("%s: no sources configured", path)
	}
	for i := range cfg.Sources {
		s := &cfg.Sources[i]
		if s.Name == "" || s.Listen == "" || s.Upstream == "" {
			return nil, fmt.Errorf("%s: source #%d needs name, listen and upstream", path, i)
		}
		if s.Context == "" {
			s.Context = "/source"
		}
		if s.ThresholdLines <= 0 {
			s.ThresholdLines = 3000
		}
	}
	return &cfg, nil
}
