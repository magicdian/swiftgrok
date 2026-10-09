// Package xref decomposes OpenGrok xref pages into per-line HTML.
//
// An xref page renders each source line as exactly one physical line in the
// HTML inside a single <pre>, starting with <a class="l" name="N">. The only
// complication is tags that span lines (block comments, strings): the opener
// lives on an earlier line than its closer. balanceLines rewrites every line
// so its tags are self-contained, which makes lines independently renderable.
package xref

import (
	"errors"
	"regexp"
	"strings"
)

var (
	// ErrNoPre indicates the page has no <pre> region (not a file view).
	ErrNoPre = errors.New("xref: <pre> region not found")

	openPreRe = regexp.MustCompile(`<pre[^>]*>`)
	tagRe     = regexp.MustCompile(`<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>`)
)

var voidElements = map[string]bool{
	"area": true, "base": true, "br": true, "col": true, "embed": true,
	"hr": true, "img": true, "input": true, "link": true, "meta": true,
	"source": true, "track": true, "wbr": true,
}

// Split is a decomposed xref page.
type Split struct {
	Head  string   // HTML up to and including the opening <pre>
	Lines []string // per-source-line HTML, each with balanced tags
	Tail  string   // HTML from </pre> to the end of the page
}

// SplitPage decomposes a full xref page HTML document.
func SplitPage(raw string) (*Split, error) {
	loc := openPreRe.FindStringIndex(raw)
	if loc == nil {
		return nil, ErrNoPre
	}
	j := strings.LastIndex(raw, "</pre>")
	if j < 0 || j < loc[1] {
		return nil, ErrNoPre
	}
	code := raw[loc[1]:j]
	rawLines := strings.Split(code, "\n")
	if n := len(rawLines); n > 0 && rawLines[n-1] == "" {
		rawLines = rawLines[:n-1]
	}
	return &Split{
		Head:  raw[:loc[1]],
		Lines: balanceLines(rawLines),
		Tail:  raw[j:],
	}, nil
}

type openTag struct{ name, raw string }

// balanceLines rewrites each line so that its tags are self-contained: tags
// opened on an earlier line are re-opened at the start of the line and closed
// again at its end. The input must be well-formed flat markup as emitted by
// OpenGrok's xref generator.
func balanceLines(lines []string) []string {
	out := make([]string, len(lines))
	var stack []openTag
	for idx, line := range lines {
		var b strings.Builder
		for _, t := range stack {
			b.WriteString(t.raw)
		}
		pos := 0
		for _, m := range tagRe.FindAllStringSubmatchIndex(line, -1) {
			b.WriteString(line[pos:m[0]])
			closing := line[m[2]:m[3]] == "/"
			name := strings.ToLower(line[m[4]:m[5]])
			full := line[m[0]:m[1]]
			switch {
			case voidElements[name] || strings.HasSuffix(full, "/>"):
				b.WriteString(full)
			case !closing:
				stack = append(stack, openTag{name, full})
				b.WriteString(full)
			default:
				if len(stack) > 0 && stack[len(stack)-1].name == name {
					stack = stack[:len(stack)-1]
				} else {
					for k := len(stack) - 1; k >= 0; k-- {
						if stack[k].name == name {
							stack = stack[:k]
							break
						}
					}
				}
				b.WriteString(full)
			}
			pos = m[1]
		}
		b.WriteString(line[pos:])
		for k := len(stack) - 1; k >= 0; k-- {
			b.WriteString("</" + stack[k].name + ">")
		}
		out[idx] = b.String()
	}
	return out
}
